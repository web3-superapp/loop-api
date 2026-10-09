import { randomUUID } from "node:crypto";

/**
 * Canonical lowercase UUIDv4 used for every new public LOOP resource ID.
 * Wallet addresses, tickers, aliases, Provider subjects, and sequential
 * database keys are never exposed as opaque IDs.
 */
export const opaqueIdPatternSource =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

const opaqueIdPattern = new RegExp(opaqueIdPatternSource);

export class InvalidOpaqueIdError extends Error {
  readonly code = "invalid_opaque_id";

  constructor() {
    super("The opaque ID is not a canonical lowercase UUIDv4");
    this.name = "InvalidOpaqueIdError";
  }
}

export function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && opaqueIdPattern.test(value);
}

export function parseOpaqueId(value: unknown): string {
  if (!isOpaqueId(value)) {
    throw new InvalidOpaqueIdError();
  }
  return value;
}

export function generateOpaqueId(): string {
  const value = randomUUID();
  if (!isOpaqueId(value)) {
    throw new InvalidOpaqueIdError();
  }
  return value;
}
