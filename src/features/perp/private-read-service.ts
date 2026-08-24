import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  HyperliquidPrivateReaderUnavailableError,
  RetryableHyperliquidReadError,
  type HyperliquidPrivateListReadKind,
  type HyperliquidPrivateReadInput,
  type HyperliquidPrivateReadKind,
  type HyperliquidPrivateReader,
} from "../../integrations/hyperliquid/private-reader.js";
import { deriveStreamUserId } from "../identity/loop-identifiers.js";
import {
  InvalidPerpReadCursorError,
  type PerpPrivateReadCursorCodec,
  type PerpPrivateReadCursorScope,
} from "./private-read-cursor.js";
import {
  WalletBindingRequiredError,
  WalletBindingResolutionUnavailableError,
  type PerpWalletBindingResolver,
  type VerifiedPerpWalletBinding,
} from "./wallet-binding-resolver.js";

const coreCoins = ["BTC", "ETH", "SOL"] as const;
const readKinds: ReadonlySet<string> = new Set([
  "config",
  "account",
  "positions",
  "orders",
  "fills",
  "funding",
]);
const listReadKinds: ReadonlySet<string> = new Set([
  "positions",
  "orders",
  "fills",
  "funding",
]);
const inputKeys: ReadonlySet<string> = new Set([
  "principal",
  "kind",
  "limit",
  "cursor",
  "signal",
]);
const principalKeys = ["userId", "privyUserId", "streamUserId"] as const;
const walletBindingKeys = [
  "ownerUserId",
  "privyUserId",
  "accountAddress",
  "accountKind",
  "bindingVersion",
  "verifiedAt",
  "expiresAt",
] as const;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const privyUserIdPattern = /^[\x21-\x7e]{1,512}$/;
const lowercaseAddressPattern = /^0x[0-9a-f]{40}$/;
const zeroAddress = `0x${"0".repeat(40)}`;
const positiveIntegerDecimalPattern = /^[1-9][0-9]{0,18}$/;
const maximumBindingVersion = 9_223_372_036_854_775_807n;
const decimalPattern =
  /^(?:(?:0|[1-9][0-9]*)(?:\.[0-9]+)?|-(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*))$/;
const positiveDecimalPattern =
  /^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/;
const unsignedIntegerPattern = /^(?:0|[1-9][0-9]*)$/;
const clientOrderIdPattern = /^0x[0-9a-f]{32}$/;
const transactionHashPattern = /^0x[0-9a-f]{64}$/;
const providerCursorStatePattern = /^[A-Za-z0-9_-]{1,768}$/;
const maximumUnsigned64 = 18_446_744_073_709_551_615n;
const maximumCursorLength = 1_536;
const maximumDecimalLength = 128;
const maximumUnsignedIntegerLength = 20;
const sourceTtlByKind = Object.freeze({
  config: 60_000,
  account: 2_000,
  positions: 2_000,
  orders: 2_000,
  fills: 2_000,
  funding: 2_000,
} as const satisfies Readonly<Record<HyperliquidPrivateReadKind, number>>);

export const PERP_PRIVATE_READ_ATTEMPT_DEADLINE_MS = 5_000;
export const PERP_PRIVATE_READ_MAX_ATTEMPTS = 2;
export const PERP_POSITIONS_DEFAULT_LIMIT = 3;
export const PERP_POSITIONS_MAX_LIMIT = 3;
export const PERP_PRIVATE_LIST_DEFAULT_LIMIT = 20;
export const PERP_PRIVATE_LIST_MAX_LIMIT = 50;

const decimalStringSchema = z
  .string()
  .max(maximumDecimalLength)
  .regex(decimalPattern);
const positiveDecimalStringSchema = z
  .string()
  .max(maximumDecimalLength)
  .regex(positiveDecimalPattern);
const positiveIntegerDecimalStringSchema = z
  .string()
  .max(maximumUnsignedIntegerLength)
  .regex(positiveIntegerDecimalPattern);
const rfc3339Schema = z.string().datetime({ offset: true });
const coreCoinSchema = z.enum(coreCoins);
const providerCursorStateSchema = z
  .string()
  .min(1)
  .max(768)
  .regex(providerCursorStatePattern);

const unavailableFactSchema = z
  .object({ state: z.literal("unavailable") })
  .strict();
const availablePositiveDecimalFactSchema = z
  .object({
    state: z.literal("available"),
    value: positiveDecimalStringSchema,
  })
  .strict();
const positiveDecimalFactSchema = z.discriminatedUnion("state", [
  unavailableFactSchema,
  availablePositiveDecimalFactSchema,
]);
const availableDecimalFactSchema = z
  .object({
    state: z.literal("available"),
    value: decimalStringSchema,
  })
  .strict();
const decimalFactSchema = z.discriminatedUnion("state", [
  unavailableFactSchema,
  availableDecimalFactSchema,
]);

const sourceSchema = z
  .object({
    provider: z.literal("hyperliquid"),
    network: z.literal("testnet"),
    market: z.literal("core_perps"),
    dex: z.literal(""),
    dataset: z.enum([
      "config",
      "account",
      "positions",
      "orders",
      "fills",
      "funding",
    ]),
    fetched_at: rfc3339Schema,
    expires_at: rfc3339Schema,
  })
  .strict();

const configSchema = z
  .object({
    scope: z
      .object({
        network: z.literal("testnet"),
        market: z.literal("core_perps"),
        dex: z.literal(""),
        coins: z.tuple([z.literal("BTC"), z.literal("ETH"), z.literal("SOL")]),
      })
      .strict(),
    assets: z
      .array(
        z
          .object({
            coin: coreCoinSchema,
            size_decimals: z.number().int().min(0).max(18),
            size_increment: positiveDecimalStringSchema,
            max_leverage: positiveIntegerDecimalStringSchema,
            margin_mode: z.enum(["cross_and_isolated", "isolated_only"]),
            minimum_order_notional_usdc: positiveDecimalFactSchema,
          })
          .strict(),
      )
      .length(3),
    fees: z
      .object({
        maker_rate: decimalFactSchema,
        taker_rate: decimalFactSchema,
      })
      .strict(),
    capabilities: z
      .object({
        private_reads: z.literal("available"),
        trading_mutations: z.literal("disabled"),
      })
      .strict(),
    source: sourceSchema,
  })
  .strict();

const marginSummarySchema = z
  .object({
    account_value: decimalStringSchema,
    total_margin_used: decimalStringSchema,
    total_notional_position: decimalStringSchema,
    total_raw_usd: decimalStringSchema,
  })
  .strict();

const accountSchema = z
  .object({
    margin_summary: marginSummarySchema,
    cross_margin_summary: marginSummarySchema,
    withdrawable: decimalStringSchema,
    cross_maintenance_margin_used: decimalStringSchema.nullable(),
    source: sourceSchema,
  })
  .strict();

const positionSchema = z
  .object({
    coin: coreCoinSchema,
    side: z.enum(["long", "short"]),
    size: positiveDecimalStringSchema,
    entry_price: decimalStringSchema.nullable(),
    leverage: z
      .object({
        mode: z.enum(["cross", "isolated"]),
        value: positiveIntegerDecimalStringSchema,
        raw_usd: decimalStringSchema.nullable(),
      })
      .strict(),
    liquidation_price: decimalStringSchema.nullable(),
    margin_used: decimalStringSchema,
    position_value: decimalStringSchema,
    return_on_equity: decimalStringSchema,
    unrealized_pnl: decimalStringSchema,
    position_mode: z.literal("one_way"),
  })
  .strict();

const orderSchema = z
  .object({
    order_id: z
      .string()
      .max(maximumUnsignedIntegerLength)
      .regex(unsignedIntegerPattern),
    client_order_id: z.string().regex(clientOrderIdPattern).nullable(),
    coin: coreCoinSchema,
    side: z.enum(["buy", "sell"]),
    order_type: z.literal("limit"),
    time_in_force: z.enum(["gtc", "alo", "ioc"]),
    limit_price: positiveDecimalStringSchema,
    original_size: positiveDecimalStringSchema,
    remaining_size: positiveDecimalStringSchema,
    reduce_only: z.boolean(),
    status: z.literal("open"),
    created_at: rfc3339Schema,
    status_at: rfc3339Schema,
  })
  .strict();

const fillSchema = z
  .object({
    trade_id: z
      .string()
      .max(maximumUnsignedIntegerLength)
      .regex(unsignedIntegerPattern),
    order_id: z
      .string()
      .max(maximumUnsignedIntegerLength)
      .regex(unsignedIntegerPattern),
    transaction_hash: z.string().regex(transactionHashPattern),
    coin: coreCoinSchema,
    side: z.enum(["buy", "sell"]),
    price: positiveDecimalStringSchema,
    size: positiveDecimalStringSchema,
    start_position: decimalStringSchema,
    closed_pnl: decimalStringSchema,
    fee: decimalStringSchema,
    fee_asset: z.literal("USDC"),
    crossed: z.boolean(),
    filled_at: rfc3339Schema,
  })
  .strict();

const fundingSchema = z
  .object({
    transaction_hash: z.string().regex(transactionHashPattern),
    coin: coreCoinSchema,
    funding_rate: decimalStringSchema,
    position_size: decimalStringSchema,
    payment_usdc: decimalStringSchema,
    settled_at: rfc3339Schema,
  })
  .strict();

const recentWindowCoverageSchema = z
  .object({
    kind: z.literal("recent_window"),
    started_at: rfc3339Schema,
    ended_at: rfc3339Schema,
    truncated: z.boolean(),
  })
  .strict();

const positionsPageSchema = z
  .object({
    items: z.array(positionSchema).max(PERP_POSITIONS_MAX_LIMIT),
    source: sourceSchema,
    next_provider_cursor_state: providerCursorStateSchema.optional(),
  })
  .strict();

const ordersPageSchema = z
  .object({
    items: z.array(orderSchema).max(PERP_PRIVATE_LIST_MAX_LIMIT),
    source: sourceSchema,
    next_provider_cursor_state: providerCursorStateSchema.optional(),
  })
  .strict();

const fillsPageSchema = z
  .object({
    items: z.array(fillSchema).max(PERP_PRIVATE_LIST_MAX_LIMIT),
    coverage: recentWindowCoverageSchema,
    source: sourceSchema,
    next_provider_cursor_state: providerCursorStateSchema.optional(),
  })
  .strict();

const fundingPageSchema = z
  .object({
    items: z.array(fundingSchema).max(PERP_PRIVATE_LIST_MAX_LIMIT),
    coverage: recentWindowCoverageSchema,
    source: sourceSchema,
    next_provider_cursor_state: providerCursorStateSchema.optional(),
  })
  .strict();

export type PerpConfigResponse = Readonly<z.infer<typeof configSchema>>;
export type PerpAccountResponse = Readonly<z.infer<typeof accountSchema>>;
export type PerpPosition = Readonly<z.infer<typeof positionSchema>>;
export type PerpOrder = Readonly<z.infer<typeof orderSchema>>;
export type PerpFill = Readonly<z.infer<typeof fillSchema>>;
export type PerpFunding = Readonly<z.infer<typeof fundingSchema>>;
export type PerpRecentWindowCoverage = Readonly<
  z.infer<typeof recentWindowCoverageSchema>
>;

export interface PerpPositionsResponse {
  readonly items: readonly PerpPosition[];
  readonly source: Readonly<z.infer<typeof sourceSchema>>;
  readonly next_cursor: string | null;
}

export interface PerpOrdersResponse {
  readonly items: readonly PerpOrder[];
  readonly source: Readonly<z.infer<typeof sourceSchema>>;
  readonly next_cursor: string | null;
}

export interface PerpFillsResponse {
  readonly items: readonly PerpFill[];
  readonly coverage: PerpRecentWindowCoverage;
  readonly source: Readonly<z.infer<typeof sourceSchema>>;
  readonly next_cursor: string | null;
}

export interface PerpFundingResponse {
  readonly items: readonly PerpFunding[];
  readonly coverage: PerpRecentWindowCoverage;
  readonly source: Readonly<z.infer<typeof sourceSchema>>;
  readonly next_cursor: string | null;
}

export type PerpPrivateReadResponse =
  | PerpConfigResponse
  | PerpAccountResponse
  | PerpPositionsResponse
  | PerpOrdersResponse
  | PerpFillsResponse
  | PerpFundingResponse;

export interface PerpPrivateReadRequest {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly kind: HyperliquidPrivateReadKind;
  readonly limit?: number;
  readonly cursor?: string;
  readonly signal: AbortSignal;
}

export interface PerpPrivateReadService {
  read(input: PerpPrivateReadRequest): Promise<PerpPrivateReadResponse>;
}

export interface CreatePerpPrivateReadServiceInput {
  readonly bindingResolver: PerpWalletBindingResolver;
  readonly cursorCodec: PerpPrivateReadCursorCodec | null;
  readonly reader: HyperliquidPrivateReader;
  readonly now?: () => Date;
  readonly createUuid?: () => string;
}

export class InvalidPerpReadRequestError extends Error {
  readonly code = "invalid_perp_read_request";

  constructor() {
    super("The Perp private read request is invalid");
    this.name = "InvalidPerpReadRequestError";
  }
}

export class PerpWalletBindingRequiredError extends Error {
  readonly code = "perp_wallet_binding_required";

  constructor() {
    super("A verified Perp wallet binding is required");
    this.name = "PerpWalletBindingRequiredError";
  }
}

export class PerpReadUnavailableError extends Error {
  readonly code = "perp_read_unavailable";

  constructor() {
    super("Perp private reads are unavailable");
    this.name = "PerpReadUnavailableError";
  }
}

export class PerpReadFailedError extends Error {
  readonly code = "perp_read_failed";

  constructor() {
    super("The Perp private read failed");
    this.name = "PerpReadFailedError";
  }
}

class PerpReadAttemptDeadlineError extends Error {
  constructor() {
    super("The Perp private read attempt deadline elapsed");
    this.name = "PerpReadAttemptDeadlineError";
  }
}

interface ValidatedRequest {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly kind: HyperliquidPrivateReadKind;
  readonly limit: number | undefined;
  readonly cursor: string | undefined;
  readonly signal: AbortSignal;
}

interface Pagination {
  readonly limit: number;
  readonly providerCursorState?: string;
}

type WithoutSignal<T> = T extends unknown ? Omit<T, "signal"> : never;
type HyperliquidPrivateReadWithoutSignal =
  WithoutSignal<HyperliquidPrivateReadInput>;

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyDataProperties(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): boolean {
  const ownKeys = Reflect.ownKeys(value);

  for (const key of ownKeys) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      return false;
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return false;
    }
  }

  return true;
}

function hasExactDataProperties(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  return (
    Reflect.ownKeys(value).length === expectedKeys.length &&
    hasOnlyDataProperties(value, new Set(expectedKeys)) &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function validatePrincipal(value: unknown): AuthenticatedLoopPrincipal {
  if (
    !isPlainDataRecord(value) ||
    !hasExactDataProperties(value, principalKeys)
  ) {
    throw new InvalidPerpReadRequestError();
  }

  const userId = value["userId"];
  const privyUserId = value["privyUserId"];
  const streamUserId = value["streamUserId"];

  if (
    typeof userId !== "string" ||
    !uuidPattern.test(userId) ||
    typeof privyUserId !== "string" ||
    !privyUserIdPattern.test(privyUserId) ||
    typeof streamUserId !== "string"
  ) {
    throw new InvalidPerpReadRequestError();
  }

  let expectedStreamUserId: string;
  try {
    expectedStreamUserId = deriveStreamUserId(userId);
  } catch {
    throw new InvalidPerpReadRequestError();
  }

  if (streamUserId !== expectedStreamUserId) {
    throw new InvalidPerpReadRequestError();
  }

  return Object.freeze({ userId, privyUserId, streamUserId });
}

function isListReadKind(
  kind: HyperliquidPrivateReadKind,
): kind is HyperliquidPrivateListReadKind {
  return listReadKinds.has(kind);
}

function maximumLimit(kind: HyperliquidPrivateListReadKind): number {
  return kind === "positions"
    ? PERP_POSITIONS_MAX_LIMIT
    : PERP_PRIVATE_LIST_MAX_LIMIT;
}

function defaultLimit(kind: HyperliquidPrivateListReadKind): number {
  return kind === "positions"
    ? PERP_POSITIONS_DEFAULT_LIMIT
    : PERP_PRIVATE_LIST_DEFAULT_LIMIT;
}

function validateRequest(value: PerpPrivateReadRequest): ValidatedRequest {
  if (
    !isPlainDataRecord(value) ||
    !hasOnlyDataProperties(value, inputKeys) ||
    !Object.hasOwn(value, "principal") ||
    !Object.hasOwn(value, "kind") ||
    !Object.hasOwn(value, "signal")
  ) {
    throw new InvalidPerpReadRequestError();
  }

  const kind = value["kind"];
  const signal = value["signal"];
  if (
    typeof kind !== "string" ||
    !readKinds.has(kind) ||
    !(signal instanceof AbortSignal)
  ) {
    throw new InvalidPerpReadRequestError();
  }

  const typedKind = kind;
  const hasLimit = Object.hasOwn(value, "limit");
  const hasCursor = Object.hasOwn(value, "cursor");
  const limit = value["limit"];
  const cursor = value["cursor"];

  if (!isListReadKind(typedKind)) {
    if (hasLimit || hasCursor) {
      throw new InvalidPerpReadRequestError();
    }

    return Object.freeze({
      principal: validatePrincipal(value["principal"]),
      kind: typedKind,
      limit: undefined,
      cursor: undefined,
      signal,
    });
  }

  if (
    (hasLimit && hasCursor) ||
    (hasLimit &&
      (typeof limit !== "number" ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > maximumLimit(typedKind))) ||
    (hasCursor &&
      (typeof cursor !== "string" ||
        cursor.length < 1 ||
        cursor.length > maximumCursorLength))
  ) {
    throw new InvalidPerpReadRequestError();
  }

  return Object.freeze({
    principal: validatePrincipal(value["principal"]),
    kind: typedKind,
    limit: hasLimit ? (limit as number) : undefined,
    cursor: hasCursor ? (cursor as string) : undefined,
    signal,
  });
}

function readNowMilliseconds(now: () => Date): number {
  const milliseconds = now().getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new PerpReadFailedError();
  }
  return milliseconds;
}

function parseTimestamp(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new PerpReadUnavailableError();
  }
  return milliseconds;
}

function parseBindingVersion(value: string): bigint {
  if (!positiveIntegerDecimalPattern.test(value)) {
    throw new PerpReadUnavailableError();
  }

  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new PerpReadUnavailableError();
  }

  if (parsed > maximumBindingVersion) {
    throw new PerpReadUnavailableError();
  }
  return parsed;
}

function validateWalletBinding(
  value: unknown,
  principal: AuthenticatedLoopPrincipal,
  nowMilliseconds: number,
): VerifiedPerpWalletBinding {
  if (value === null || value === undefined || Array.isArray(value)) {
    throw new PerpWalletBindingRequiredError();
  }

  if (
    !isPlainDataRecord(value) ||
    !hasExactDataProperties(value, walletBindingKeys)
  ) {
    throw new PerpReadUnavailableError();
  }

  const ownerUserId = value["ownerUserId"];
  const privyUserId = value["privyUserId"];
  const accountAddress = value["accountAddress"];
  const accountKind = value["accountKind"];
  const bindingVersion = value["bindingVersion"];
  const verifiedAt = value["verifiedAt"];
  const expiresAt = value["expiresAt"];

  if (
    ownerUserId !== principal.userId ||
    privyUserId !== principal.privyUserId ||
    typeof accountAddress !== "string" ||
    !lowercaseAddressPattern.test(accountAddress) ||
    typeof bindingVersion !== "string" ||
    typeof verifiedAt !== "string" ||
    typeof expiresAt !== "string"
  ) {
    throw new PerpReadUnavailableError();
  }

  if (
    accountAddress === zeroAddress ||
    accountKind === "agent" ||
    accountKind === "unapproved"
  ) {
    throw new PerpWalletBindingRequiredError();
  }

  if (accountKind !== "master" && accountKind !== "subaccount") {
    throw new PerpReadUnavailableError();
  }

  parseBindingVersion(bindingVersion);
  if (
    !rfc3339Schema.safeParse(verifiedAt).success ||
    !rfc3339Schema.safeParse(expiresAt).success
  ) {
    throw new PerpReadUnavailableError();
  }

  const verifiedAtMilliseconds = parseTimestamp(verifiedAt);
  const expiresAtMilliseconds = parseTimestamp(expiresAt);
  if (
    verifiedAtMilliseconds > nowMilliseconds ||
    verifiedAtMilliseconds >= expiresAtMilliseconds
  ) {
    throw new PerpReadUnavailableError();
  }

  if (expiresAtMilliseconds <= nowMilliseconds) {
    throw new PerpWalletBindingRequiredError();
  }

  return Object.freeze({
    ownerUserId,
    privyUserId,
    accountAddress,
    accountKind,
    bindingVersion,
    verifiedAt,
    expiresAt,
  });
}

function abortWithOuterReason(signal: AbortSignal): never {
  signal.throwIfAborted();
  throw new PerpReadFailedError();
}

async function resolveWalletBinding(
  resolver: PerpWalletBindingResolver,
  request: ValidatedRequest,
  now: () => Date,
): Promise<VerifiedPerpWalletBinding> {
  request.signal.throwIfAborted();

  let rawBinding: unknown;
  try {
    rawBinding = await resolver.resolve({
      ownerUserId: request.principal.userId,
      privyUserId: request.principal.privyUserId,
      signal: request.signal,
    });
  } catch (error) {
    if (request.signal.aborted) {
      return abortWithOuterReason(request.signal);
    }
    if (error instanceof WalletBindingRequiredError) {
      throw new PerpWalletBindingRequiredError();
    }
    if (error instanceof WalletBindingResolutionUnavailableError) {
      throw new PerpReadUnavailableError();
    }
    throw new PerpReadFailedError();
  }

  request.signal.throwIfAborted();
  try {
    return validateWalletBinding(
      rawBinding,
      request.principal,
      readNowMilliseconds(now),
    );
  } catch (error) {
    if (
      error instanceof PerpWalletBindingRequiredError ||
      error instanceof PerpReadUnavailableError
    ) {
      throw error;
    }
    throw new PerpReadUnavailableError();
  }
}

function assertBindingStillCurrent(
  binding: VerifiedPerpWalletBinding,
  nowMilliseconds: number,
): void {
  if (parseTimestamp(binding.expiresAt) <= nowMilliseconds) {
    throw new PerpWalletBindingRequiredError();
  }
}

function resolvePagination(
  request: ValidatedRequest,
  binding: VerifiedPerpWalletBinding,
  codec: PerpPrivateReadCursorCodec,
): Pagination | undefined {
  if (!isListReadKind(request.kind)) {
    return undefined;
  }

  if (request.cursor === undefined) {
    return Object.freeze({
      limit: request.limit ?? defaultLimit(request.kind),
    });
  }

  try {
    const decoded = codec.decode({
      cursor: request.cursor,
      ownerUserId: request.principal.userId,
      accountAddress: binding.accountAddress,
      bindingVersion: binding.bindingVersion,
      scope: request.kind,
    });
    if (decoded.limit < 1 || decoded.limit > maximumLimit(request.kind)) {
      throw new InvalidPerpReadRequestError();
    }
    return Object.freeze({
      limit: decoded.limit,
      providerCursorState: decoded.providerCursorState,
    });
  } catch (error) {
    if (
      error instanceof InvalidPerpReadCursorError ||
      error instanceof InvalidPerpReadRequestError
    ) {
      throw new InvalidPerpReadRequestError();
    }
    throw new PerpReadFailedError();
  }
}

function createAttemptId(createUuid: () => string, seen: Set<string>): string {
  let value: string;
  try {
    value = createUuid();
  } catch {
    throw new PerpReadFailedError();
  }

  if (!uuidPattern.test(value) || seen.has(value)) {
    throw new PerpReadFailedError();
  }
  seen.add(value);
  return value;
}

function abortReason(
  outerSignal: AbortSignal,
  deadlineError: PerpReadAttemptDeadlineError,
): Error {
  if (outerSignal.aborted) {
    return outerSignal.reason instanceof Error
      ? outerSignal.reason
      : new DOMException("The request was aborted", "AbortError");
  }
  return deadlineError;
}

async function readAttempt(
  reader: HyperliquidPrivateReader,
  input: HyperliquidPrivateReadWithoutSignal,
  outerSignal: AbortSignal,
): Promise<unknown> {
  outerSignal.throwIfAborted();
  const deadlineController = new AbortController();
  const deadlineError = new PerpReadAttemptDeadlineError();
  const signal = AbortSignal.any([outerSignal, deadlineController.signal]);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => reject(abortReason(outerSignal, deadlineError));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const timer = setTimeout(() => {
    deadlineController.abort(deadlineError);
  }, PERP_PRIVATE_READ_ATTEMPT_DEADLINE_MS);

  try {
    return await Promise.race([
      Promise.resolve().then(() => reader.read({ ...input, signal })),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function readerInput(
  request: ValidatedRequest,
  binding: VerifiedPerpWalletBinding,
  pagination: Pagination | undefined,
  transportAttemptId: string,
): HyperliquidPrivateReadWithoutSignal {
  const base = {
    network: "testnet",
    dex: "",
    accountAddress: binding.accountAddress,
    transportAttemptId,
  } as const;

  if (!isListReadKind(request.kind)) {
    return { ...base, kind: request.kind };
  }

  if (pagination === undefined) {
    throw new PerpReadFailedError();
  }

  return pagination.providerCursorState === undefined
    ? { ...base, kind: request.kind, limit: pagination.limit }
    : {
        ...base,
        kind: request.kind,
        limit: pagination.limit,
        providerCursorState: pagination.providerCursorState,
      };
}

async function readWithRetry(
  reader: HyperliquidPrivateReader,
  request: ValidatedRequest,
  binding: VerifiedPerpWalletBinding,
  pagination: Pagination | undefined,
  createUuid: () => string,
  now: () => Date,
): Promise<unknown> {
  const attemptIds = new Set<string>();

  for (
    let attempt = 1;
    attempt <= PERP_PRIVATE_READ_MAX_ATTEMPTS;
    attempt += 1
  ) {
    assertBindingStillCurrent(binding, readNowMilliseconds(now));
    const transportAttemptId = createAttemptId(createUuid, attemptIds);
    try {
      return await readAttempt(
        reader,
        readerInput(request, binding, pagination, transportAttemptId),
        request.signal,
      );
    } catch (error) {
      if (request.signal.aborted) {
        return abortWithOuterReason(request.signal);
      }

      if (
        error instanceof PerpReadAttemptDeadlineError ||
        error instanceof RetryableHyperliquidReadError
      ) {
        if (attempt < PERP_PRIVATE_READ_MAX_ATTEMPTS) {
          continue;
        }
        throw new PerpReadUnavailableError();
      }

      if (error instanceof HyperliquidPrivateReaderUnavailableError) {
        throw new PerpReadUnavailableError();
      }

      throw new PerpReadFailedError();
    }
  }

  throw new PerpReadUnavailableError();
}

function validateSource(
  source: z.infer<typeof sourceSchema>,
  kind: HyperliquidPrivateReadKind,
  nowMilliseconds: number,
): void {
  if (source.dataset !== kind) {
    throw new PerpReadUnavailableError();
  }

  const fetchedAt = parseTimestamp(source.fetched_at);
  const expiresAt = parseTimestamp(source.expires_at);
  if (
    fetchedAt > nowMilliseconds ||
    expiresAt <= nowMilliseconds ||
    expiresAt <= fetchedAt ||
    expiresAt - fetchedAt > sourceTtlByKind[kind]
  ) {
    throw new PerpReadUnavailableError();
  }
}

function parseUnsigned64(value: string): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new PerpReadUnavailableError();
  }
  if (parsed > maximumUnsigned64) {
    throw new PerpReadUnavailableError();
  }
  return parsed;
}

function validatePositions(items: readonly PerpPosition[]): void {
  let previousIndex = -1;
  for (const item of items) {
    const currentIndex = coreCoins.indexOf(item.coin);
    if (currentIndex <= previousIndex) {
      throw new PerpReadUnavailableError();
    }
    previousIndex = currentIndex;
  }
}

function validateTimestampIdOrder(
  items: readonly Record<string, unknown>[],
  timestampKey: string,
  idKey: string,
): void {
  let previousTime = Number.POSITIVE_INFINITY;
  let previousId: bigint | undefined;
  const seenIds = new Set<string>();

  for (const item of items) {
    const timestamp = item[timestampKey];
    const id = item[idKey];
    if (typeof timestamp !== "string" || typeof id !== "string") {
      throw new PerpReadUnavailableError();
    }
    const time = parseTimestamp(timestamp);
    const numericId = parseUnsigned64(id);
    if (
      seenIds.has(id) ||
      time > previousTime ||
      (time === previousTime &&
        previousId !== undefined &&
        numericId >= previousId)
    ) {
      throw new PerpReadUnavailableError();
    }
    seenIds.add(id);
    previousTime = time;
    previousId = numericId;
  }
}

function validateFundingOrder(items: readonly PerpFunding[]): void {
  let previousTime = Number.POSITIVE_INFINITY;
  let previousCoinIndex: number | undefined;
  const seenKeys = new Set<string>();

  for (const item of items) {
    const time = parseTimestamp(item.settled_at);
    const coinIndex = coreCoins.indexOf(item.coin);
    const uniqueKey = `${item.transaction_hash}\0${item.coin}`;
    if (
      seenKeys.has(uniqueKey) ||
      time > previousTime ||
      (time === previousTime &&
        previousCoinIndex !== undefined &&
        coinIndex <= previousCoinIndex)
    ) {
      throw new PerpReadUnavailableError();
    }
    seenKeys.add(uniqueKey);
    previousTime = time;
    previousCoinIndex = coinIndex;
  }
}

function compareUnsignedDecimals(left: string, right: string): number {
  const [leftInteger = "", leftFraction = ""] = left.split(".");
  const [rightInteger = "", rightFraction = ""] = right.split(".");
  if (leftInteger.length !== rightInteger.length) {
    return leftInteger.length < rightInteger.length ? -1 : 1;
  }
  if (leftInteger !== rightInteger) {
    return leftInteger < rightInteger ? -1 : 1;
  }

  const fractionLength = Math.max(leftFraction.length, rightFraction.length);
  const leftPaddedFraction = leftFraction.padEnd(fractionLength, "0");
  const rightPaddedFraction = rightFraction.padEnd(fractionLength, "0");
  if (leftPaddedFraction === rightPaddedFraction) {
    return 0;
  }
  return leftPaddedFraction < rightPaddedFraction ? -1 : 1;
}

function validateCoverage(
  coverage: PerpRecentWindowCoverage,
  source: z.infer<typeof sourceSchema>,
): void {
  const startedAt = parseTimestamp(coverage.started_at);
  const endedAt = parseTimestamp(coverage.ended_at);
  const fetchedAt = parseTimestamp(source.fetched_at);
  if (startedAt > endedAt || endedAt > fetchedAt) {
    throw new PerpReadUnavailableError();
  }
}

function validateTimestampWithinSource(
  value: string,
  source: z.infer<typeof sourceSchema>,
): void {
  if (parseTimestamp(value) > parseTimestamp(source.fetched_at)) {
    throw new PerpReadUnavailableError();
  }
}

function validateTimestampWithinCoverage(
  value: string,
  coverage: PerpRecentWindowCoverage,
): void {
  const milliseconds = parseTimestamp(value);
  if (
    milliseconds < parseTimestamp(coverage.started_at) ||
    milliseconds > parseTimestamp(coverage.ended_at)
  ) {
    throw new PerpReadUnavailableError();
  }
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

function createNextCursor(
  codec: PerpPrivateReadCursorCodec,
  request: ValidatedRequest,
  binding: VerifiedPerpWalletBinding,
  pagination: Pagination,
  itemCount: number,
  providerCursorState: string | undefined,
): string | null {
  if (providerCursorState !== undefined && itemCount !== pagination.limit) {
    throw new PerpReadUnavailableError();
  }
  if (providerCursorState === undefined) {
    return null;
  }

  try {
    return codec.encode({
      ownerUserId: request.principal.userId,
      accountAddress: binding.accountAddress,
      bindingVersion: binding.bindingVersion,
      scope: request.kind as PerpPrivateReadCursorScope,
      limit: pagination.limit,
      providerCursorState,
    });
  } catch {
    throw new PerpReadUnavailableError();
  }
}

function parseProviderResult(
  value: unknown,
  request: ValidatedRequest,
  binding: VerifiedPerpWalletBinding,
  pagination: Pagination | undefined,
  codec: PerpPrivateReadCursorCodec,
  nowMilliseconds: number,
): PerpPrivateReadResponse {
  try {
    switch (request.kind) {
      case "config": {
        const result = configSchema.parse(value);
        validateSource(result.source, request.kind, nowMilliseconds);
        if (
          !result.assets.every(
            (asset, index) => asset.coin === coreCoins[index],
          )
        ) {
          throw new PerpReadUnavailableError();
        }
        return deepFreeze(result);
      }
      case "account": {
        const result = accountSchema.parse(value);
        validateSource(result.source, request.kind, nowMilliseconds);
        return deepFreeze(result);
      }
      case "positions": {
        const result = positionsPageSchema.parse(value);
        if (
          pagination === undefined ||
          result.items.length > pagination.limit
        ) {
          throw new PerpReadUnavailableError();
        }
        validateSource(result.source, request.kind, nowMilliseconds);
        validatePositions(result.items);
        return deepFreeze({
          items: result.items,
          source: result.source,
          next_cursor: createNextCursor(
            codec,
            request,
            binding,
            pagination,
            result.items.length,
            result.next_provider_cursor_state,
          ),
        });
      }
      case "orders": {
        const result = ordersPageSchema.parse(value);
        if (
          pagination === undefined ||
          result.items.length > pagination.limit
        ) {
          throw new PerpReadUnavailableError();
        }
        validateSource(result.source, request.kind, nowMilliseconds);
        for (const item of result.items) {
          parseUnsigned64(item.order_id);
          if (
            parseTimestamp(item.status_at) < parseTimestamp(item.created_at) ||
            compareUnsignedDecimals(item.remaining_size, item.original_size) > 0
          ) {
            throw new PerpReadUnavailableError();
          }
          validateTimestampWithinSource(item.created_at, result.source);
          validateTimestampWithinSource(item.status_at, result.source);
        }
        validateTimestampIdOrder(result.items, "created_at", "order_id");
        const clientOrderIds = result.items
          .map((item) => item.client_order_id)
          .filter((value): value is string => value !== null);
        if (new Set(clientOrderIds).size !== clientOrderIds.length) {
          throw new PerpReadUnavailableError();
        }
        return deepFreeze({
          items: result.items,
          source: result.source,
          next_cursor: createNextCursor(
            codec,
            request,
            binding,
            pagination,
            result.items.length,
            result.next_provider_cursor_state,
          ),
        });
      }
      case "fills": {
        const result = fillsPageSchema.parse(value);
        if (
          pagination === undefined ||
          result.items.length > pagination.limit
        ) {
          throw new PerpReadUnavailableError();
        }
        validateSource(result.source, request.kind, nowMilliseconds);
        validateCoverage(result.coverage, result.source);
        for (const item of result.items) {
          parseUnsigned64(item.trade_id);
          parseUnsigned64(item.order_id);
          validateTimestampWithinCoverage(item.filled_at, result.coverage);
        }
        validateTimestampIdOrder(result.items, "filled_at", "trade_id");
        return deepFreeze({
          items: result.items,
          coverage: result.coverage,
          source: result.source,
          next_cursor: createNextCursor(
            codec,
            request,
            binding,
            pagination,
            result.items.length,
            result.next_provider_cursor_state,
          ),
        });
      }
      case "funding": {
        const result = fundingPageSchema.parse(value);
        if (
          pagination === undefined ||
          result.items.length > pagination.limit
        ) {
          throw new PerpReadUnavailableError();
        }
        validateSource(result.source, request.kind, nowMilliseconds);
        validateCoverage(result.coverage, result.source);
        for (const item of result.items) {
          validateTimestampWithinCoverage(item.settled_at, result.coverage);
        }
        validateFundingOrder(result.items);
        return deepFreeze({
          items: result.items,
          coverage: result.coverage,
          source: result.source,
          next_cursor: createNextCursor(
            codec,
            request,
            binding,
            pagination,
            result.items.length,
            result.next_provider_cursor_state,
          ),
        });
      }
    }
  } catch (error) {
    if (error instanceof PerpReadUnavailableError) {
      throw error;
    }
    throw new PerpReadUnavailableError();
  }
}

export function createPerpPrivateReadService(
  input: CreatePerpPrivateReadServiceInput,
): PerpPrivateReadService {
  const now = input.now ?? (() => new Date());
  const createUuid = input.createUuid ?? randomUUID;

  return Object.freeze({
    async read(
      requestInput: PerpPrivateReadRequest,
    ): Promise<PerpPrivateReadResponse> {
      const request = validateRequest(requestInput);
      request.signal.throwIfAborted();
      const binding = await resolveWalletBinding(
        input.bindingResolver,
        request,
        now,
      );

      if (input.cursorCodec === null) {
        throw new PerpReadUnavailableError();
      }

      const pagination = resolvePagination(request, binding, input.cursorCodec);
      const rawResult = await readWithRetry(
        input.reader,
        request,
        binding,
        pagination,
        createUuid,
        now,
      );
      request.signal.throwIfAborted();
      const completedAtMilliseconds = readNowMilliseconds(now);
      validateWalletBinding(
        binding,
        request.principal,
        completedAtMilliseconds,
      );
      return parseProviderResult(
        rawResult,
        request,
        binding,
        pagination,
        input.cursorCodec,
        completedAtMilliseconds,
      );
    },
  });
}
