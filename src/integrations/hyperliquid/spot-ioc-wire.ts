import { OrderRequest } from "@nktkas/hyperliquid/api/exchange";
import { canonicalize } from "@nktkas/hyperliquid/signing";
import { z } from "zod";

import type { SpotCanonicalAction } from "../../database/spot-intent-repository.js";

const maximumPostgresInteger = 2_147_483_647;
const maximumSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
const twoDaysMilliseconds = 2 * 24 * 60 * 60 * 1_000;
const oneDayMilliseconds = 24 * 60 * 60 * 1_000;
const zeroAddress = `0x${"0".repeat(40)}`;

const canonicalPositiveDecimalSchema = z
  .string()
  .max(128)
  .regex(/^(?:[1-9][0-9]*|0\.[0-9]*[1-9]|[1-9][0-9]*\.[0-9]*[1-9])$/);
const canonicalActionSchema = z
  .object({
    type: z.literal("order"),
    orders: z.tuple([
      z
        .object({
          a: z.number().int().min(10_000).max(maximumPostgresInteger),
          b: z.boolean(),
          p: canonicalPositiveDecimalSchema,
          s: canonicalPositiveDecimalSchema,
          r: z.literal(false),
          t: z
            .object({
              limit: z.object({ tif: z.literal("Ioc") }).strict(),
            })
            .strict(),
          c: z.string().regex(/^0x[0-9a-f]{32}$/),
        })
        .strict(),
    ]),
    grouping: z.literal("na"),
  })
  .strict();
const addressSchema = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/)
  .refine((value) => value !== zeroAddress);
const canonicalTimestampSchema = z
  .string()
  .max(24)
  .datetime({ offset: false, precision: 3 })
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const opaqueSignerRefSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim());
const requestIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
const signatureSchema = z
  .object({
    r: z.string().regex(/^0x[0-9a-f]{64}$/),
    s: z.string().regex(/^0x[0-9a-f]{64}$/),
    v: z.union([z.literal(27), z.literal(28)]),
  })
  .strict();

export class HyperliquidSpotIocAdapterUnavailableError extends Error {
  readonly code = "hyperliquid_spot_ioc_adapter_unavailable";

  constructor() {
    super("The Hyperliquid Spot IOC adapter is unavailable");
    this.name = "HyperliquidSpotIocAdapterUnavailableError";
  }
}

function unavailable(): never {
  throw new HyperliquidSpotIocAdapterUnavailableError();
}

export function parseHyperliquidSpotIocAction(
  value: unknown,
): SpotCanonicalAction {
  const parsed = canonicalActionSchema.safeParse(value);
  if (!parsed.success) {
    return unavailable();
  }
  try {
    return canonicalize(OrderRequest.entries.action, parsed.data);
  } catch {
    return unavailable();
  }
}

export function parseHyperliquidSpotIocAddress(value: unknown): `0x${string}` {
  const parsed = addressSchema.safeParse(value);
  return parsed.success ? (parsed.data as `0x${string}`) : unavailable();
}

export function parseHyperliquidSpotIocSignerRef(value: unknown): string {
  const parsed = opaqueSignerRefSchema.safeParse(value);
  return parsed.success ? parsed.data : unavailable();
}

export function parseHyperliquidSpotIocRequestId(value: unknown): string {
  const parsed = requestIdSchema.safeParse(value);
  return parsed.success ? parsed.data : unavailable();
}

export function parseHyperliquidSpotIocSignature(value: unknown): Readonly<{
  r: string;
  s: string;
  v: 27 | 28;
}> {
  const parsed = signatureSchema.safeParse(value);
  return parsed.success ? Object.freeze(parsed.data) : unavailable();
}

export function parseHyperliquidSpotIocSignatureHex(
  value: unknown,
): `0x${string}` {
  if (
    typeof value !== "string" ||
    !/^0x[0-9a-fA-F]{128}(?:00|01|1b|1B|1c|1C)$/.test(value)
  ) {
    return unavailable();
  }
  return value.toLowerCase() as `0x${string}`;
}

export function parseHyperliquidJsonSafeUnsignedInteger(
  value: unknown,
): number {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    return unavailable();
  }
  let exact: bigint;
  try {
    exact = BigInt(value);
  } catch {
    return unavailable();
  }
  if (exact > maximumSafeInteger) {
    return unavailable();
  }
  const numeric = Number(exact);
  return Number.isSafeInteger(numeric) && numeric.toString() === value
    ? numeric
    : unavailable();
}

export function assertHyperliquidSpotIocTiming(input: {
  readonly nonce: string;
  readonly expiresAfter: string;
  readonly attemptDeadlineAt: string;
  readonly signal: AbortSignal;
  readonly nowMilliseconds: number;
}): Readonly<{
  nonce: number;
  expiresAfter: number;
  attemptDeadlineAt: number;
}> {
  if (!(input.signal instanceof AbortSignal)) {
    return unavailable();
  }
  input.signal.throwIfAborted();
  const nonce = parseHyperliquidJsonSafeUnsignedInteger(input.nonce);
  const expiresAfter = parseHyperliquidJsonSafeUnsignedInteger(
    input.expiresAfter,
  );
  const timestamp = canonicalTimestampSchema.safeParse(input.attemptDeadlineAt);
  const attemptDeadlineAt = timestamp.success
    ? Date.parse(timestamp.data)
    : Number.NaN;
  if (
    !Number.isSafeInteger(input.nowMilliseconds) ||
    input.nowMilliseconds < 0 ||
    !Number.isSafeInteger(attemptDeadlineAt) ||
    input.nowMilliseconds >= attemptDeadlineAt ||
    attemptDeadlineAt >= expiresAfter ||
    nonce <= input.nowMilliseconds - twoDaysMilliseconds ||
    nonce >= input.nowMilliseconds + oneDayMilliseconds
  ) {
    return unavailable();
  }
  return Object.freeze({ nonce, expiresAfter, attemptDeadlineAt });
}
