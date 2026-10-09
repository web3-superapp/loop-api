import type { z } from "zod";

export type DeepReadonly<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export class InvalidSpotContractValueError extends Error {
  readonly code = "invalid_spot_contract_value";

  constructor() {
    super("The Spot contract value is invalid");
    this.name = "InvalidSpotContractValueError";
  }
}

function invalidContract(): never {
  throw new InvalidSpotContractValueError();
}

function assertJsonDataTree(value: unknown, ancestors: WeakSet<object>): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      invalidContract();
    }
    return;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    invalidContract();
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        invalidContract();
      }
      for (const key of Reflect.ownKeys(value)) {
        if (
          key !== "length" &&
          (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key))
        ) {
          invalidContract();
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          invalidContract();
        }
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          invalidContract();
        }
        assertJsonDataTree(descriptor.value, ancestors);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      invalidContract();
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        invalidContract();
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        invalidContract();
      }
      assertJsonDataTree(descriptor.value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value as DeepReadonly<T>;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value) as DeepReadonly<T>;
}

export function parseSpotContract<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): DeepReadonly<z.output<Schema>> {
  try {
    assertJsonDataTree(value, new WeakSet());
    return deepFreeze(schema.parse(value));
  } catch (error) {
    if (error instanceof InvalidSpotContractValueError) {
      throw error;
    }
    throw new InvalidSpotContractValueError();
  }
}

export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value !== "object") {
    invalidContract();
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
