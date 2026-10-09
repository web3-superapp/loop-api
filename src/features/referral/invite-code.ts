import { randomBytes } from "node:crypto";

/**
 * Invite code: `LOOP-` + four random Crockford Base32 symbols + one check
 * symbol (Decision 0036). Codes are random and unique (the repository
 * retries on a unique-constraint collision), never sequential, so a code
 * cannot be enumerated from another one. The check symbol is a weighted sum
 * over the four data symbols with weights coprime to 32, so any single-symbol
 * error is detected.
 */

export const inviteCodeAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ" as const;
export const inviteCodePrefix = "LOOP-" as const;
export const inviteCodeDataLength = 4;
export const inviteCodePatternSource = "^LOOP-[0-9A-HJKMNP-TV-Z]{5}$";
export const maximumInviteCodeAllocationAttempts = 8;

const inviteCodePattern = new RegExp(inviteCodePatternSource);
const checkWeights = [1, 3, 5, 7] as const;

export class InvalidInviteCodeError extends Error {
  readonly code = "invalid_invite_code";

  constructor() {
    super("The invite code is not a canonical LOOP-XXXXC code");
    this.name = "InvalidInviteCodeError";
  }
}

function symbolValue(symbol: string): number {
  const value = inviteCodeAlphabet.indexOf(symbol);
  if (value < 0) {
    throw new InvalidInviteCodeError();
  }
  return value;
}

export function inviteCodeCheckSymbol(data: string): string {
  if (data.length !== inviteCodeDataLength) {
    throw new InvalidInviteCodeError();
  }
  let sum = 0;
  for (let index = 0; index < inviteCodeDataLength; index += 1) {
    sum += (checkWeights[index] ?? 0) * symbolValue(data.charAt(index));
  }
  return inviteCodeAlphabet.charAt(sum % 32);
}

/**
 * Canonical form of user input: trimmed, upper-cased, Crockford decoding
 * (`I`/`L` → `1`, `O` → `0`), with the prefix added when omitted.
 */
export function normalizeInviteCode(value: unknown): string {
  if (typeof value !== "string" || value.length > 32) {
    throw new InvalidInviteCodeError();
  }
  let body = value.trim().toUpperCase().replaceAll("-", "");
  if (body.startsWith("LOOP")) {
    body = body.slice(4);
  }
  body = body.replaceAll("I", "1").replaceAll("L", "1").replaceAll("O", "0");
  const code = `${inviteCodePrefix}${body}`;
  if (!inviteCodePattern.test(code)) {
    throw new InvalidInviteCodeError();
  }
  return code;
}

export function isInviteCode(value: unknown): value is string {
  if (typeof value !== "string" || !inviteCodePattern.test(value)) {
    return false;
  }
  const data = value.slice(inviteCodePrefix.length, -1);
  return value.endsWith(inviteCodeCheckSymbol(data));
}

export function parseInviteCode(value: unknown): string {
  const code = normalizeInviteCode(value);
  if (!isInviteCode(code)) {
    throw new InvalidInviteCodeError();
  }
  return code;
}

export function generateInviteCode(): string {
  const bytes = randomBytes(4);
  let value = 0;
  for (const byte of bytes) {
    value = (value * 256 + byte) % 2 ** 20;
  }
  let data = "";
  for (let index = 0; index < inviteCodeDataLength; index += 1) {
    data = `${inviteCodeAlphabet.charAt(value & 31)}${data}`;
    value >>= 5;
  }
  return parseInviteCode(
    `${inviteCodePrefix}${data}${inviteCodeCheckSymbol(data)}`,
  );
}
