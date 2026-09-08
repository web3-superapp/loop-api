/**
 * Deterministic JSON serialisation: object keys sorted, arrays in order, no
 * whitespace. Every intent digest (Decision 0035) is computed over this form
 * so the same payload always yields the same SHA-256 regardless of the key
 * order a runtime happened to produce.
 */

export class NonCanonicalJsonValueError extends Error {
  readonly code = "non_canonical_json_value";

  constructor() {
    super("The value cannot be canonically serialised");
    this.name = "NonCanonicalJsonValueError";
  }
}

export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new NonCanonicalJsonValueError();
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new NonCanonicalJsonValueError();
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
