import { z } from "zod";

export const WATCHLIST_MAX_GROUPS = 20;
export const WATCHLIST_MAX_ITEMS = 100;

const maximumRecordVersion = 2_147_483_647;
const groupKeyPattern = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const assetKeyPattern = /^[A-Z0-9][A-Z0-9:_-]{0,63}$/;
const forbiddenDisplayCodePointPattern =
  /[\p{Cc}\p{Cs}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

type DeepReadonly<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

function isValidDisplayName(value: string): boolean {
  const codePointLength = Array.from(value).length;
  return (
    codePointLength >= 1 &&
    codePointLength <= 40 &&
    !forbiddenDisplayCodePointPattern.test(value)
  );
}

const normalizedDisplayNameSchema = z
  .string()
  .max(256)
  .refine((value) => !forbiddenDisplayCodePointPattern.test(value))
  .transform((value) => value.trim())
  .refine(isValidDisplayName);

const canonicalDisplayNameSchema = z
  .string()
  .max(256)
  .refine((value) => value === value.trim() && isValidDisplayName(value));

const itemSchema = z
  .object({ asset_key: z.string().regex(assetKeyPattern) })
  .strict();

const inputGroupSchema = z
  .object({
    key: z.string().regex(groupKeyPattern),
    name: normalizedDisplayNameSchema,
    items: z.array(itemSchema).max(WATCHLIST_MAX_ITEMS),
  })
  .strict()
  .refine(
    ({ items }) =>
      new Set(items.map(({ asset_key }) => asset_key)).size === items.length,
  );

const canonicalGroupSchema = z
  .object({
    key: z.string().regex(groupKeyPattern),
    name: canonicalDisplayNameSchema,
    items: z.array(itemSchema).max(WATCHLIST_MAX_ITEMS),
  })
  .strict()
  .refine(
    ({ items }) =>
      new Set(items.map(({ asset_key }) => asset_key)).size === items.length,
  );

function groupsAreValid(
  groups: readonly {
    readonly key: string;
    readonly items: readonly unknown[];
  }[],
): boolean {
  return (
    new Set(groups.map(({ key }) => key)).size === groups.length &&
    groups.reduce((total, { items }) => total + items.length, 0) <=
      WATCHLIST_MAX_ITEMS
  );
}

const replaceRequestSchema = z
  .object({
    expected_version: z.number().int().min(0).max(maximumRecordVersion),
    groups: z.array(inputGroupSchema).max(WATCHLIST_MAX_GROUPS),
  })
  .strict()
  .refine(({ groups }) => groupsAreValid(groups));

const snapshotSchema = z
  .object({
    version: z.number().int().min(0).max(maximumRecordVersion),
    groups: z.array(canonicalGroupSchema).max(WATCHLIST_MAX_GROUPS),
    updated_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
  .refine(
    ({ groups, updated_at: updatedAt, version }) =>
      groupsAreValid(groups) &&
      (version === 0
        ? groups.length === 0 && updatedAt === null
        : updatedAt !== null),
  );

export type WatchlistReplaceRequest = DeepReadonly<
  z.output<typeof replaceRequestSchema>
>;
export type WatchlistGroup = DeepReadonly<
  z.output<typeof canonicalGroupSchema>
>;
export type WatchlistSnapshot = DeepReadonly<z.output<typeof snapshotSchema>>;

export class InvalidWatchlistContractError extends Error {
  readonly code = "invalid_watchlist_contract";

  constructor() {
    super("The Watchlist contract value is invalid");
    this.name = "InvalidWatchlistContractError";
  }
}

export class WatchlistVersionConflictError extends Error {
  readonly code = "version_conflict";

  constructor() {
    super("The Watchlist version conflicts with the current resource");
    this.name = "WatchlistVersionConflictError";
  }
}

function assertJsonDataTree(value: unknown, ancestors: WeakSet<object>): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      !Object.is(value, -0))
  ) {
    return;
  }

  if (typeof value !== "object") {
    throw new InvalidWatchlistContractError();
  }

  if (ancestors.has(value)) {
    throw new InvalidWatchlistContractError();
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new InvalidWatchlistContractError();
      }
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) {
        throw new InvalidWatchlistContractError();
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          throw new InvalidWatchlistContractError();
        }
        assertJsonDataTree(descriptor.value, ancestors);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new InvalidWatchlistContractError();
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new InvalidWatchlistContractError();
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new InvalidWatchlistContractError();
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

function parseStrict<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): DeepReadonly<z.output<Schema>> {
  try {
    assertJsonDataTree(value, new WeakSet());
    return deepFreeze(schema.parse(value));
  } catch (error) {
    if (error instanceof InvalidWatchlistContractError) {
      throw error;
    }
    throw new InvalidWatchlistContractError();
  }
}

export function parseWatchlistReplaceRequest(
  value: unknown,
): WatchlistReplaceRequest {
  return parseStrict(replaceRequestSchema, value);
}

export function parseWatchlistSnapshot(value: unknown): WatchlistSnapshot {
  return parseStrict(snapshotSchema, value);
}

export function watchlistGroupsEqual(
  left: readonly WatchlistGroup[],
  right: readonly WatchlistGroup[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((leftGroup, groupIndex) => {
    const rightGroup = right[groupIndex];
    return (
      rightGroup !== undefined &&
      leftGroup.key === rightGroup.key &&
      leftGroup.name === rightGroup.name &&
      leftGroup.items.length === rightGroup.items.length &&
      leftGroup.items.every(
        (leftItem, itemIndex) =>
          leftItem.asset_key === rightGroup.items[itemIndex]?.asset_key,
      )
    );
  });
}

export function emptyWatchlistSnapshot(): WatchlistSnapshot {
  return parseWatchlistSnapshot({
    version: 0,
    groups: [],
    updated_at: null,
  });
}
