import type { SpotCanonicalAction } from "../../database/spot-intent-repository.js";
import {
  digestSpotIntentRequest,
  parseSpotIntentRequest,
  createSpotReview,
  type SpotIntentRequest,
} from "../../features/spot/spot-intent-contract.js";
import {
  addExactUnsignedDecimals,
  compareExactUnsignedDecimals,
  multiplyExactUnsignedDecimals,
} from "../../features/spot/spot-exact-decimal.js";
import {
  SPOT_INTENT_PREPARE_POLICY_V1,
  parseSpotIntentPrepareAuthority,
  parseSpotIntentReviewDraft,
  SpotIntentReviewerUnavailableError,
  type SpotIntentPrepareAuthority,
  type SpotIntentReviewDraft,
  type SpotIntentReviewer,
} from "../../features/spot/spot-intent-prepare.js";
import {
  HYPERLIQUID_TESTNET_USDC_TOKEN_ID,
  type HyperliquidSpotBookLevel,
  type HyperliquidSpotInfoReader,
} from "./spot-info-contract.js";
import {
  canonicalizeExactUnsignedDecimal,
  ceilExactUnsignedDecimalToScale,
  floorExactUnsignedDecimalQuotient,
  formatHyperliquidSpotIocLimitPrice,
  hasAtMostExactUnsignedDecimalPlaces,
  isHyperliquidSpotWirePrice,
  subtractExactUnsignedDecimals,
} from "./spot-order-precision.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const addressPattern = /^0x[0-9a-f]{40}$/;
const tokenIdPattern = /^0x[0-9a-f]{32}$/;
const clientOrderIdPattern = /^0x[0-9a-f]{32}$/;
const providerCoinPattern =
  /^(?:[A-Z0-9][A-Z0-9._-]{0,30}\/[A-Z0-9][A-Z0-9._-]{0,30}|@(?:0|[1-9][0-9]{0,9}))$/;
const displayIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$/;
const policyVersionPattern = /^[a-z][a-z0-9_]{0,63}$/;
const positiveIntegerPattern = /^[1-9][0-9]*$/;
const canonicalTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const minimumQuoteNotional = "10";
const defaultTimeoutMilliseconds = 8_000;
const maximumTimeoutMilliseconds = 14_000;

export interface HyperliquidSpotIntentReviewerPolicy {
  /** Version must identify the exact reviewed caps supplied with this adapter. */
  readonly version: string;
  readonly maximumQuoteNotional: string;
  readonly maximumTakerFeeRate: string;
}

export interface CreateHyperliquidSpotIntentReviewerInput {
  readonly infoReader: HyperliquidSpotInfoReader;
  readonly policy: HyperliquidSpotIntentReviewerPolicy;
  readonly timeoutMilliseconds?: number;
  readonly now?: () => Date;
}

interface ValidatedPolicy {
  readonly version: string;
  readonly maximumQuoteNotional: string;
  readonly maximumTakerFeeRate: string;
}

interface ReviewedToken {
  readonly tokenIndex: number;
  readonly tokenId: string;
  readonly symbol: string;
  readonly sizeDecimals: number;
  readonly weiDecimals: number;
}

interface ReviewedMarket {
  readonly marketId: string;
  readonly coin: string;
  readonly base: ReviewedToken;
  readonly quote: ReviewedToken;
  readonly spotPairIndex: number;
  readonly exchangeOrderAsset: number;
}

interface ReviewedMetadata {
  readonly market: ReviewedMarket;
  readonly metadataVersion: string;
  readonly fetchedAt: string;
  readonly expiresAt: string;
}

interface ReviewedBook {
  readonly marketId: string;
  readonly coin: string;
  readonly bids: readonly HyperliquidSpotBookLevel[];
  readonly asks: readonly HyperliquidSpotBookLevel[];
  readonly bestBid: HyperliquidSpotBookLevel;
  readonly bestAsk: HyperliquidSpotBookLevel;
  readonly providerTime: string;
  readonly fetchedAt: string;
  readonly expiresAt: string;
}

interface ReviewedFees {
  readonly accountSpotTakerRate: string;
  readonly fetchedAt: string;
  readonly expiresAt: string;
}

function unavailable(): never {
  throw new SpotIntentReviewerUnavailableError();
}

function awaitWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      const reason: unknown = signal.reason;
      finish(() =>
        reject(
          reason instanceof Error
            ? reason
            : new SpotIntentReviewerUnavailableError(),
        ),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) =>
        finish(() =>
          reject(
            error instanceof Error
              ? error
              : new SpotIntentReviewerUnavailableError(),
          ),
        ),
    );
  });
}

function isDataRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNow(now: () => Date): number {
  const value = now();
  if (!(value instanceof Date)) {
    return unavailable();
  }
  const milliseconds = value.getTime();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    return unavailable();
  }
  return milliseconds;
}

function timestampMilliseconds(value: unknown): number {
  if (typeof value !== "string" || !canonicalTimestampPattern.test(value)) {
    return unavailable();
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    new Date(milliseconds).toISOString() !== value
  ) {
    return unavailable();
  }
  return milliseconds;
}

function validateFreshWindow(
  fetchedAt: unknown,
  expiresAt: unknown,
  observedAtMilliseconds: number,
): void {
  const fetchedAtMilliseconds = timestampMilliseconds(fetchedAt);
  const expiresAtMilliseconds = timestampMilliseconds(expiresAt);
  if (
    fetchedAtMilliseconds > observedAtMilliseconds ||
    expiresAtMilliseconds <= observedAtMilliseconds ||
    fetchedAtMilliseconds >= expiresAtMilliseconds
  ) {
    return unavailable();
  }
}

function validatePolicy(
  value: HyperliquidSpotIntentReviewerPolicy,
): ValidatedPolicy {
  const maximumQuoteNotional = canonicalizeExactUnsignedDecimal(
    value.maximumQuoteNotional,
  );
  const maximumTakerFeeRate = canonicalizeExactUnsignedDecimal(
    value.maximumTakerFeeRate,
  );
  if (
    typeof value.version !== "string" ||
    !policyVersionPattern.test(value.version) ||
    maximumQuoteNotional === null ||
    compareExactUnsignedDecimals(maximumQuoteNotional, minimumQuoteNotional) <
      0 ||
    maximumTakerFeeRate === null ||
    compareExactUnsignedDecimals(maximumTakerFeeRate, "1") >= 0
  ) {
    throw new TypeError("Hyperliquid Spot reviewer policy is invalid");
  }
  return Object.freeze({
    version: value.version,
    maximumQuoteNotional,
    maximumTakerFeeRate,
  });
}

function validateToken(value: unknown): ReviewedToken {
  if (
    !isDataRecord(value) ||
    typeof value["tokenIndex"] !== "number" ||
    !Number.isSafeInteger(value["tokenIndex"]) ||
    value["tokenIndex"] < 0 ||
    typeof value["tokenId"] !== "string" ||
    !tokenIdPattern.test(value["tokenId"]) ||
    typeof value["symbol"] !== "string" ||
    !displayIdentityPattern.test(value["symbol"]) ||
    typeof value["sizeDecimals"] !== "number" ||
    !Number.isSafeInteger(value["sizeDecimals"]) ||
    value["sizeDecimals"] < 0 ||
    value["sizeDecimals"] > 8 ||
    typeof value["weiDecimals"] !== "number" ||
    !Number.isSafeInteger(value["weiDecimals"]) ||
    value["weiDecimals"] < value["sizeDecimals"] ||
    value["weiDecimals"] > 18
  ) {
    return unavailable();
  }
  return Object.freeze({
    tokenIndex: value["tokenIndex"],
    tokenId: value["tokenId"],
    symbol: value["symbol"],
    sizeDecimals: value["sizeDecimals"],
    weiDecimals: value["weiDecimals"],
  });
}

function resolveMarket(snapshot: unknown, marketId: string): ReviewedMetadata {
  if (
    !isDataRecord(snapshot) ||
    !Array.isArray(snapshot["markets"]) ||
    typeof snapshot["metadataVersion"] !== "string" ||
    !sha256Pattern.test(snapshot["metadataVersion"]) ||
    !isDataRecord(snapshot["source"]) ||
    snapshot["source"]["provider"] !== "hyperliquid" ||
    snapshot["source"]["network"] !== "testnet" ||
    snapshot["source"]["dataset"] !== "spotMetaAndAssetCtxs" ||
    typeof snapshot["source"]["fetchedAt"] !== "string" ||
    typeof snapshot["source"]["expiresAt"] !== "string"
  ) {
    return unavailable();
  }
  const matches = snapshot["markets"].filter(
    (candidate) =>
      isDataRecord(candidate) && candidate["marketId"] === marketId,
  );
  if (matches.length !== 1) {
    return unavailable();
  }
  const market: unknown = matches[0];
  if (
    !isDataRecord(market) ||
    typeof market["coin"] !== "string" ||
    !providerCoinPattern.test(market["coin"]) ||
    typeof market["spotPairIndex"] !== "number" ||
    !Number.isSafeInteger(market["spotPairIndex"]) ||
    market["spotPairIndex"] < 0 ||
    typeof market["exchangeOrderAsset"] !== "number" ||
    !Number.isSafeInteger(market["exchangeOrderAsset"]) ||
    market["exchangeOrderAsset"] !== 10_000 + market["spotPairIndex"]
  ) {
    return unavailable();
  }
  const base = validateToken(market["base"]);
  const quote = validateToken(market["quote"]);
  if (
    base.tokenIndex === quote.tokenIndex ||
    base.tokenId === quote.tokenId ||
    base.symbol === quote.symbol ||
    quote.tokenId !== HYPERLIQUID_TESTNET_USDC_TOKEN_ID ||
    quote.symbol !== "USDC" ||
    quote.sizeDecimals !== 8 ||
    quote.weiDecimals !== 8
  ) {
    return unavailable();
  }
  return Object.freeze({
    market: Object.freeze({
      marketId,
      coin: market["coin"],
      base,
      quote,
      spotPairIndex: market["spotPairIndex"],
      exchangeOrderAsset: market["exchangeOrderAsset"],
    }),
    metadataVersion: snapshot["metadataVersion"],
    fetchedAt: snapshot["source"]["fetchedAt"],
    expiresAt: snapshot["source"]["expiresAt"],
  });
}

function canonicalPositiveDecimal(value: unknown): string {
  const canonical = canonicalizeExactUnsignedDecimal(value);
  if (canonical === null || canonical === "0") {
    return unavailable();
  }
  return canonical;
}

function validateLevel(
  value: unknown,
  sizeDecimals: number,
): HyperliquidSpotBookLevel {
  if (
    !isDataRecord(value) ||
    typeof value["price"] !== "string" ||
    !isHyperliquidSpotWirePrice(value["price"], sizeDecimals) ||
    typeof value["size"] !== "string" ||
    !hasAtMostExactUnsignedDecimalPlaces(value["size"], sizeDecimals) ||
    canonicalizeExactUnsignedDecimal(value["size"]) === "0" ||
    typeof value["orderCount"] !== "string" ||
    !positiveIntegerPattern.test(value["orderCount"])
  ) {
    return unavailable();
  }
  return Object.freeze({
    price: value["price"],
    size: value["size"],
    orderCount: value["orderCount"],
  });
}

function exactLevelEqual(
  left: HyperliquidSpotBookLevel,
  right: HyperliquidSpotBookLevel,
): boolean {
  return (
    compareExactUnsignedDecimals(left.price, right.price) === 0 &&
    compareExactUnsignedDecimals(left.size, right.size) === 0 &&
    left.orderCount === right.orderCount
  );
}

function validateBook(
  snapshot: unknown,
  market: ReviewedMarket,
  metadataVersion: string,
): ReviewedBook {
  if (
    !isDataRecord(snapshot) ||
    snapshot["marketId"] !== market.marketId ||
    snapshot["coin"] !== market.coin ||
    !Array.isArray(snapshot["bids"]) ||
    !Array.isArray(snapshot["asks"]) ||
    snapshot["bids"].length < 1 ||
    snapshot["bids"].length > 20 ||
    snapshot["asks"].length < 1 ||
    snapshot["asks"].length > 20 ||
    !isDataRecord(snapshot["source"]) ||
    snapshot["source"]["provider"] !== "hyperliquid" ||
    snapshot["source"]["network"] !== "testnet" ||
    snapshot["source"]["dataset"] !== "l2Book" ||
    snapshot["source"]["metadataVersion"] !== metadataVersion ||
    typeof snapshot["source"]["providerTime"] !== "string" ||
    typeof snapshot["source"]["fetchedAt"] !== "string" ||
    typeof snapshot["source"]["expiresAt"] !== "string"
  ) {
    return unavailable();
  }
  const bids = snapshot["bids"].map((level) =>
    validateLevel(level, market.base.sizeDecimals),
  );
  const asks = snapshot["asks"].map((level) =>
    validateLevel(level, market.base.sizeDecimals),
  );
  for (let index = 1; index < bids.length; index += 1) {
    if (
      compareExactUnsignedDecimals(
        bids[index - 1]!.price,
        bids[index]!.price,
      ) <= 0
    ) {
      return unavailable();
    }
  }
  for (let index = 1; index < asks.length; index += 1) {
    if (
      compareExactUnsignedDecimals(
        asks[index - 1]!.price,
        asks[index]!.price,
      ) >= 0
    ) {
      return unavailable();
    }
  }
  const bestBid = validateLevel(snapshot["bestBid"], market.base.sizeDecimals);
  const bestAsk = validateLevel(snapshot["bestAsk"], market.base.sizeDecimals);
  if (
    !exactLevelEqual(bestBid, bids[0]!) ||
    !exactLevelEqual(bestAsk, asks[0]!) ||
    compareExactUnsignedDecimals(bestBid.price, bestAsk.price) >= 0
  ) {
    return unavailable();
  }
  return Object.freeze({
    marketId: market.marketId,
    coin: market.coin,
    bids: Object.freeze(bids),
    asks: Object.freeze(asks),
    bestBid,
    bestAsk,
    providerTime: snapshot["source"]["providerTime"],
    fetchedAt: snapshot["source"]["fetchedAt"],
    expiresAt: snapshot["source"]["expiresAt"],
  });
}

function validateEvidenceFreshness(
  metadata: ReviewedMetadata,
  book: ReviewedBook,
  fees: ReviewedFees,
  observedAtMilliseconds: number,
): void {
  validateFreshWindow(
    metadata.fetchedAt,
    metadata.expiresAt,
    observedAtMilliseconds,
  );
  validateFreshWindow(book.fetchedAt, book.expiresAt, observedAtMilliseconds);
  validateFreshWindow(fees.fetchedAt, fees.expiresAt, observedAtMilliseconds);
  const providerTime = timestampMilliseconds(book.providerTime);
  if (
    providerTime > observedAtMilliseconds ||
    observedAtMilliseconds - providerTime >
      SPOT_INTENT_PREPARE_POLICY_V1.maximumReferenceAgeMilliseconds
  ) {
    return unavailable();
  }
}

function validateFees(snapshot: unknown): ReviewedFees {
  if (
    !isDataRecord(snapshot) ||
    typeof snapshot["accountSpotTakerRate"] !== "string" ||
    !isDataRecord(snapshot["source"]) ||
    snapshot["source"]["provider"] !== "hyperliquid" ||
    snapshot["source"]["network"] !== "testnet" ||
    snapshot["source"]["dataset"] !== "userFees" ||
    typeof snapshot["source"]["fetchedAt"] !== "string" ||
    typeof snapshot["source"]["expiresAt"] !== "string"
  ) {
    return unavailable();
  }
  return Object.freeze({
    accountSpotTakerRate: snapshot["accountSpotTakerRate"],
    fetchedAt: snapshot["source"]["fetchedAt"],
    expiresAt: snapshot["source"]["expiresAt"],
  });
}

function walkDepth(
  levels: readonly HyperliquidSpotBookLevel[],
  side: "buy" | "sell",
  limitPrice: string,
  requestedSize: string,
): string | null {
  let remaining = requestedSize;
  let expectedNotional = "0";
  for (const level of levels) {
    const priceDirection = compareExactUnsignedDecimals(
      level.price,
      limitPrice,
    );
    if (side === "buy" ? priceDirection > 0 : priceDirection < 0) {
      break;
    }
    const canonicalLevelSize = canonicalPositiveDecimal(level.size);
    const fillSize =
      compareExactUnsignedDecimals(canonicalLevelSize, remaining) >= 0
        ? remaining
        : canonicalLevelSize;
    const fillNotional = multiplyExactUnsignedDecimals(level.price, fillSize);
    const nextNotional =
      fillNotional === null
        ? null
        : addExactUnsignedDecimals([expectedNotional, fillNotional]);
    const nextRemaining = subtractExactUnsignedDecimals(remaining, fillSize);
    if (nextNotional === null || nextRemaining === null) {
      return unavailable();
    }
    expectedNotional = nextNotional;
    remaining = nextRemaining;
    if (remaining === "0") {
      return expectedNotional;
    }
  }
  return null;
}

function buildCanonicalAction(
  market: ReviewedMarket,
  request: SpotIntentRequest,
  limitPrice: string,
  computedBaseSize: string,
  clientOrderId: string,
): SpotCanonicalAction {
  return Object.freeze({
    type: "order",
    orders: Object.freeze([
      Object.freeze({
        a: market.exchangeOrderAsset,
        b: request.side === "buy",
        p: limitPrice,
        s: computedBaseSize,
        r: false,
        t: Object.freeze({
          limit: Object.freeze({ tif: "Ioc" as const }),
        }),
        c: clientOrderId,
      }),
    ] as const),
    grouping: "na",
  });
}

function validateInput(
  rawInput: unknown,
  policy: ValidatedPolicy,
  now: () => Date,
): Readonly<{
  ownerUserId: string;
  request: SpotIntentRequest;
  authority: SpotIntentPrepareAuthority;
  clientOrderId: string;
  requestId: string;
  signal: AbortSignal;
}> {
  if (
    !isDataRecord(rawInput) ||
    typeof rawInput["ownerUserId"] !== "string" ||
    !uuidPattern.test(rawInput["ownerUserId"]) ||
    rawInput["network"] !== "testnet" ||
    typeof rawInput["requestSha256"] !== "string" ||
    !sha256Pattern.test(rawInput["requestSha256"]) ||
    typeof rawInput["clientOrderId"] !== "string" ||
    !clientOrderIdPattern.test(rawInput["clientOrderId"]) ||
    typeof rawInput["requestId"] !== "string" ||
    !uuidPattern.test(rawInput["requestId"]) ||
    !(rawInput["signal"] instanceof AbortSignal) ||
    !isDataRecord(rawInput["authority"])
  ) {
    return unavailable();
  }
  const signal = rawInput["signal"];
  signal.throwIfAborted();
  const request = parseSpotIntentRequest(rawInput["request"]);
  if (
    digestSpotIntentRequest(request) !== rawInput["requestSha256"] ||
    (request.max_slippage_bps !== undefined &&
      request.max_slippage_bps >
        SPOT_INTENT_PREPARE_POLICY_V1.maximumMaxSlippageBasisPoints)
  ) {
    return unavailable();
  }
  const rawAuthority = rawInput["authority"];
  if (typeof rawAuthority["privyUserId"] !== "string") {
    return unavailable();
  }
  const authority = parseSpotIntentPrepareAuthority(
    rawAuthority,
    {
      ownerUserId: rawInput["ownerUserId"],
      privyUserId: rawAuthority["privyUserId"],
    },
    readNow(now),
  );
  if (
    authority.ownerUserId !== rawInput["ownerUserId"] ||
    !addressPattern.test(authority.accountAddress) ||
    (request.side === "buy" &&
      compareExactUnsignedDecimals(
        request.amount.value,
        policy.maximumQuoteNotional,
      ) > 0)
  ) {
    return unavailable();
  }
  return Object.freeze({
    ownerUserId: rawInput["ownerUserId"],
    request,
    authority,
    clientOrderId: rawInput["clientOrderId"],
    requestId: rawInput["requestId"],
    signal,
  });
}

function calculateReviewValues(
  request: SpotIntentRequest,
  market: ReviewedMarket,
  book: ReviewedBook,
  feeRate: string,
  policy: ValidatedPolicy,
): Readonly<{
  computedBaseSize: string;
  referencePrice: string;
  worstIocLimitPrice: string;
  maximumSpendOrMinimumReceive: string;
  feeEstimate: string;
}> {
  const referencePrice = canonicalPositiveDecimal(
    request.side === "buy" ? book.bestAsk.price : book.bestBid.price,
  );
  const worstIocLimitPrice = formatHyperliquidSpotIocLimitPrice({
    referencePrice,
    side: request.side,
    slippageBasisPoints:
      request.max_slippage_bps ??
      SPOT_INTENT_PREPARE_POLICY_V1.defaultMaxSlippageBasisPoints,
    sizeDecimals: market.base.sizeDecimals,
  });
  if (worstIocLimitPrice === null) {
    return unavailable();
  }

  let computedBaseSize: string;
  let feeEstimate: string;
  let maximumSpendOrMinimumReceive: string;
  if (request.side === "buy") {
    const conservativeFee = multiplyExactUnsignedDecimals(
      request.amount.value,
      feeRate,
    );
    const roundedConservativeFee =
      conservativeFee === null
        ? null
        : ceilExactUnsignedDecimalToScale(
            conservativeFee,
            market.quote.weiDecimals,
          );
    const quoteForOrder =
      roundedConservativeFee === null
        ? null
        : subtractExactUnsignedDecimals(
            request.amount.value,
            roundedConservativeFee,
          );
    const size =
      quoteForOrder === null
        ? null
        : floorExactUnsignedDecimalQuotient(
            quoteForOrder,
            worstIocLimitPrice,
            market.base.sizeDecimals,
          );
    if (size === null || size === "0" || roundedConservativeFee === null) {
      return unavailable();
    }
    computedBaseSize = size;
    feeEstimate = roundedConservativeFee;
    maximumSpendOrMinimumReceive = request.amount.value;
  } else {
    const size = canonicalPositiveDecimal(request.amount.value);
    if (!hasAtMostExactUnsignedDecimalPlaces(size, market.base.sizeDecimals)) {
      return unavailable();
    }
    computedBaseSize = size;
    const referenceNotional = multiplyExactUnsignedDecimals(
      referencePrice,
      computedBaseSize,
    );
    if (
      referenceNotional === null ||
      compareExactUnsignedDecimals(
        referenceNotional,
        policy.maximumQuoteNotional,
      ) > 0
    ) {
      return unavailable();
    }
    const worstNotional = multiplyExactUnsignedDecimals(
      worstIocLimitPrice,
      computedBaseSize,
    );
    const rawFee = multiplyExactUnsignedDecimals(referenceNotional, feeRate);
    const fee =
      rawFee === null
        ? null
        : ceilExactUnsignedDecimalToScale(rawFee, market.quote.weiDecimals);
    const minimumReceive =
      worstNotional === null || fee === null
        ? null
        : subtractExactUnsignedDecimals(worstNotional, fee);
    if (fee === null || minimumReceive === null || minimumReceive === "0") {
      return unavailable();
    }
    feeEstimate = fee;
    maximumSpendOrMinimumReceive = minimumReceive;
  }

  const worstNotional = multiplyExactUnsignedDecimals(
    worstIocLimitPrice,
    computedBaseSize,
  );
  const minimumFee =
    worstNotional === null
      ? null
      : multiplyExactUnsignedDecimals(worstNotional, feeRate);
  const spendWithFee =
    worstNotional === null
      ? null
      : addExactUnsignedDecimals([worstNotional, feeEstimate]);
  if (
    worstNotional === null ||
    minimumFee === null ||
    compareExactUnsignedDecimals(worstNotional, minimumQuoteNotional) < 0 ||
    compareExactUnsignedDecimals(feeEstimate, minimumFee) < 0 ||
    (request.side === "buy" &&
      (spendWithFee === null ||
        compareExactUnsignedDecimals(spendWithFee, request.amount.value) > 0))
  ) {
    return unavailable();
  }
  const depthNotional = walkDepth(
    request.side === "buy" ? book.asks : book.bids,
    request.side,
    worstIocLimitPrice,
    computedBaseSize,
  );
  if (
    depthNotional === null ||
    (request.side === "buy"
      ? compareExactUnsignedDecimals(depthNotional, worstNotional) > 0
      : compareExactUnsignedDecimals(depthNotional, worstNotional) < 0)
  ) {
    return unavailable();
  }
  return Object.freeze({
    computedBaseSize,
    referencePrice,
    worstIocLimitPrice,
    maximumSpendOrMinimumReceive,
    feeEstimate,
  });
}

export function createHyperliquidSpotIntentReviewer(
  input: CreateHyperliquidSpotIntentReviewerInput,
): SpotIntentReviewer {
  const policy = validatePolicy(input.policy);
  const timeoutMilliseconds =
    input.timeoutMilliseconds ?? defaultTimeoutMilliseconds;
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds <= 0 ||
    timeoutMilliseconds > maximumTimeoutMilliseconds
  ) {
    throw new TypeError("Hyperliquid Spot reviewer timeout is invalid");
  }
  const now = input.now ?? (() => new Date());

  return Object.freeze({
    async review(rawInput: Parameters<SpotIntentReviewer["review"]>[0]) {
      let externalSignal: AbortSignal | undefined;
      try {
        if (
          isDataRecord(rawInput) &&
          rawInput["signal"] instanceof AbortSignal
        ) {
          externalSignal = rawInput["signal"];
        }
        const validated = validateInput(rawInput, policy, now);
        externalSignal = validated.signal;
        const deadlineSignal = AbortSignal.any([
          validated.signal,
          AbortSignal.timeout(timeoutMilliseconds),
        ]);
        deadlineSignal.throwIfAborted();

        const rawMetadata = await awaitWithAbort(
          input.infoReader.readMetadata({ signal: deadlineSignal }),
          deadlineSignal,
        );
        deadlineSignal.throwIfAborted();
        const metadata = resolveMarket(
          rawMetadata,
          validated.request.market_id,
        );
        const market = metadata.market;
        if (
          (validated.request.side === "buy" &&
            !hasAtMostExactUnsignedDecimalPlaces(
              validated.request.amount.value,
              market.quote.weiDecimals,
            )) ||
          (validated.request.side === "sell" &&
            !hasAtMostExactUnsignedDecimalPlaces(
              validated.request.amount.value,
              market.base.sizeDecimals,
            ))
        ) {
          return unavailable();
        }

        const [rawBook, rawFees] = await awaitWithAbort(
          Promise.all([
            input.infoReader.readBook({
              marketId: validated.request.market_id,
              signal: deadlineSignal,
            }),
            input.infoReader.readUserFees({
              accountAddress: validated.authority.accountAddress,
              signal: deadlineSignal,
            }),
          ]),
          deadlineSignal,
        );
        deadlineSignal.throwIfAborted();
        const book = validateBook(rawBook, market, metadata.metadataVersion);
        const fees = validateFees(rawFees);
        const observedFeeRate = canonicalizeExactUnsignedDecimal(
          fees.accountSpotTakerRate,
        );
        if (
          observedFeeRate === null ||
          compareExactUnsignedDecimals(
            observedFeeRate,
            policy.maximumTakerFeeRate,
          ) > 0
        ) {
          return unavailable();
        }
        // Persist the reviewed policy ceiling rather than the momentary lower
        // observation so the settlement bound survives an allowed fee change.
        const feeRate = policy.maximumTakerFeeRate;

        const factsObservedAtMilliseconds = readNow(now);
        validateEvidenceFreshness(
          metadata,
          book,
          fees,
          factsObservedAtMilliseconds,
        );
        const values = calculateReviewValues(
          validated.request,
          market,
          book,
          feeRate,
          policy,
        );
        const factsObservedAt = new Date(
          factsObservedAtMilliseconds,
        ).toISOString();
        const expiresAtMilliseconds =
          factsObservedAtMilliseconds +
          SPOT_INTENT_PREPARE_POLICY_V1.maximumReviewLifetimeMilliseconds;
        if (!Number.isSafeInteger(expiresAtMilliseconds)) {
          return unavailable();
        }
        const expiresAt = new Date(expiresAtMilliseconds).toISOString();
        const canonicalAction = buildCanonicalAction(
          market,
          validated.request,
          values.worstIocLimitPrice,
          values.computedBaseSize,
          validated.clientOrderId,
        );
        const publicReview = createSpotReview({
          version: "spot_review_v1",
          provider: "hyperliquid",
          network: "testnet",
          market_id: validated.request.market_id,
          base_display_identity: market.base.symbol,
          quote_display_identity: market.quote.symbol,
          side: validated.request.side,
          amount_mode: validated.request.amount.mode,
          amount_value: validated.request.amount.value,
          computed_base_size: values.computedBaseSize,
          reference_price: values.referencePrice,
          reference_source_time: book.providerTime,
          worst_ioc_limit_price: values.worstIocLimitPrice,
          maximum_spend_or_minimum_receive: {
            kind:
              validated.request.side === "buy"
                ? "maximum_spend"
                : "minimum_receive",
            asset_display_identity: market.quote.symbol,
            value: values.maximumSpendOrMinimumReceive,
          },
          fee_rate: feeRate,
          fee_estimate: values.feeEstimate,
          fee_source: {
            dataset: "user_fees",
            observed_at: fees.fetchedAt,
          },
          metadata_version: metadata.metadataVersion,
          policy_version: policy.version,
          binding_epoch: validated.authority.bindingVersion,
          expires_at: expiresAt,
        });
        const rawDraft: SpotIntentReviewDraft = Object.freeze({
          providerCoin: market.coin,
          baseTokenIndex: market.base.tokenIndex,
          baseTokenId: market.base.tokenId,
          quoteTokenIndex: market.quote.tokenIndex,
          quoteTokenId: market.quote.tokenId,
          spotPairIndex: market.spotPairIndex,
          exchangeOrderAsset: market.exchangeOrderAsset,
          metadataVersion: metadata.metadataVersion,
          // The reader's v1 metadataVersion is already the domain-separated
          // SHA-256 of the canonical allowlisted registry projection.
          metadataSha256: metadata.metadataVersion,
          policyVersion: policy.version,
          computedBaseSize: values.computedBaseSize,
          referencePrice: values.referencePrice,
          worstIocLimitPrice: values.worstIocLimitPrice,
          maximumSpendOrMinimumReceive: values.maximumSpendOrMinimumReceive,
          feeRate,
          feeEstimate: values.feeEstimate,
          canonicalAction,
          publicReview,
          reviewSha256: publicReview.review_digest,
          factsObservedAt,
          referenceSourceTime: book.providerTime,
          expiresAt,
        });
        return parseSpotIntentReviewDraft(rawDraft, {
          request: validated.request,
          authority: validated.authority,
          clientOrderId: validated.clientOrderId,
          observedAtMilliseconds: factsObservedAtMilliseconds,
        });
      } catch (error) {
        externalSignal?.throwIfAborted();
        if (error instanceof SpotIntentReviewerUnavailableError) {
          throw error;
        }
        return unavailable();
      }
    },
  });
}
