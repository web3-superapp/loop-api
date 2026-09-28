import { randomBytes } from "node:crypto";

/**
 * Public LOOP ID: `LOOP-` plus eight Crockford Base32 characters drawn from
 * 40 cryptographically random bits. It is assigned once when the LOOP
 * account is created, is globally unique, immutable, and not enumerable.
 * It is presentation identity only and never an authorization key.
 */
export const loopIdAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ" as const;
export const loopIdPrefix = "LOOP-" as const;
export const loopIdBodyLength = 8;
export const loopIdPatternSource = "^LOOP-[0-9A-HJKMNP-TV-Z]{8}$";
export const maximumLoopIdAllocationAttempts = 5;

const loopIdPattern = new RegExp(loopIdPatternSource);
const randomByteCount = 5;

export class InvalidLoopIdError extends Error {
  readonly code = "invalid_loop_id";

  constructor() {
    super("The LOOP ID is not a canonical LOOP-XXXXXXXX identifier");
    this.name = "InvalidLoopIdError";
  }
}

export class LoopIdAllocationExhaustedError extends Error {
  readonly code = "loop_id_allocation_exhausted";

  constructor() {
    super(
      `LOOP ID allocation conflicted ${maximumLoopIdAllocationAttempts} times`,
    );
    this.name = "LoopIdAllocationExhaustedError";
  }
}

export function isLoopId(value: unknown): value is string {
  return typeof value === "string" && loopIdPattern.test(value);
}

export function parseLoopId(value: unknown): string {
  if (!isLoopId(value)) {
    throw new InvalidLoopIdError();
  }
  return value;
}

/**
 * Search-box form of a LOOP ID (Decision 0090): `LOOP-` plus eight ASCII
 * letters or digits, case-insensitive, surrounding whitespace allowed. The
 * shape is deliberately looser than the Crockford alphabet so a mistyped
 * `I`/`L`/`O`/`U` still takes the exact-match path (and simply matches
 * nobody). Returns the upper-cased ID, or `null` for any other query.
 */
export const loopIdSearchPatternSource = "^LOOP-[0-9A-Z]{8}$";
const loopIdSearchInputPattern = /^LOOP-[0-9A-Z]{8}$/i;

export function loopIdSearchQuery(value: string): string | null {
  const trimmed = value.trim();
  return loopIdSearchInputPattern.test(trimmed) ? trimmed.toUpperCase() : null;
}

export function generateLoopId(): string {
  const bytes = randomBytes(randomByteCount);
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  let encoded = "";
  for (let index = 0; index < loopIdBodyLength; index += 1) {
    encoded = `${loopIdAlphabet[Number(value & 31n)] ?? "0"}${encoded}`;
    value >>= 5n;
  }
  return parseLoopId(`${loopIdPrefix}${encoded}`);
}

export type LoopIdAllocationAttempt<T> =
  | { readonly status: "allocated"; readonly value: T }
  | { readonly status: "conflict" };

export interface AllocateLoopIdInput<T> {
  /** Try to persist one candidate; report `conflict` only for a LOOP ID unique violation. */
  readonly attempt: (candidate: string) => Promise<LoopIdAllocationAttempt<T>>;
  readonly generate?: () => string;
}

/**
 * Allocate a LOOP ID by retrying fresh random candidates on unique-constraint
 * conflicts. After `maximumLoopIdAllocationAttempts` conflicts the caller
 * fails closed (projected as INTERNAL_ERROR); it never falls back to a
 * sequential or client-supplied value.
 */
export async function allocateLoopId<T>(
  input: AllocateLoopIdInput<T>,
): Promise<T> {
  const generate = input.generate ?? generateLoopId;
  for (
    let attemptIndex = 0;
    attemptIndex < maximumLoopIdAllocationAttempts;
    attemptIndex += 1
  ) {
    const candidate = parseLoopId(generate());
    const outcome = await input.attempt(candidate);
    if (outcome.status === "allocated") {
      return outcome.value;
    }
  }
  throw new LoopIdAllocationExhaustedError();
}
