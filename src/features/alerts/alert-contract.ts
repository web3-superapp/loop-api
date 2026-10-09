import { createHash } from "node:crypto";

import { z } from "zod";

export const PRICE_ALERT_CREATE_DIGEST_VERSION = "price_alert_create_v1";
export const PRICE_ALERT_IDEMPOTENCY_SCOPE = "price_alert_create";

export const priceAlertConditions = [
  "above",
  "at_or_above",
  "below",
  "at_or_below",
] as const;

export const notificationEventTypes = [
  "price_alert_triggered",
  "provider_activity_projected",
  "security_notice",
  "support_update",
] as const;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const assetKeyPattern = /^[A-Z0-9][A-Z0-9:_-]{0,63}$/;
const decimalPattern = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const sourcePattern = /^[a-z][a-z0-9_]{0,63}$/;
const sourceFactRefPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digestDomain = "loop.price-alert.create.v1\0";

const uuidSchema = z.string().regex(uuidPattern);
const assetKeySchema = z.string().regex(assetKeyPattern);
const decimalSchema = z.string().max(96).regex(decimalPattern);
const conditionSchema = z.enum(priceAlertConditions);
const rfc3339Schema = z.string().max(64).datetime({ offset: true });

const definitionSchema = z
  .object({
    asset_key: assetKeySchema,
    condition: conditionSchema,
    threshold_decimal: decimalSchema,
    expires_at: rfc3339Schema.nullable(),
  })
  .strict()
  .transform((value) => ({
    ...value,
    expires_at:
      value.expires_at === null
        ? null
        : new Date(value.expires_at).toISOString(),
  }));

const replaceDefinitionSchema = z
  .object({
    asset_key: assetKeySchema,
    condition: conditionSchema,
    threshold_decimal: decimalSchema,
    expires_at: rfc3339Schema.nullable(),
    expected_version: z.number().int().positive(),
  })
  .strict()
  .transform((value) => ({
    ...value,
    expires_at:
      value.expires_at === null
        ? null
        : new Date(value.expires_at).toISOString(),
  }));

const alertResourceSchema = z
  .object({
    alert_id: uuidSchema,
    asset_key: assetKeySchema,
    condition: conditionSchema,
    threshold_decimal: decimalSchema,
    expires_at: rfc3339Schema.nullable(),
    state: z.literal("inactive"),
    evaluation: z.object({ state: z.literal("unavailable") }).strict(),
    delivery: z.object({ state: z.literal("unavailable") }).strict(),
    version: z.number().int().positive(),
    created_at: rfc3339Schema,
    updated_at: rfc3339Schema,
  })
  .strict();

const alertListSchema = z
  .object({
    items: z.array(alertResourceSchema),
    next_offset: z.number().int().nonnegative().nullable(),
  })
  .strict();

const historyItemSchema = z
  .object({
    event_id: uuidSchema,
    alert_id: uuidSchema,
    asset_key: assetKeySchema,
    condition: conditionSchema,
    threshold_decimal: decimalSchema,
    value_decimal: decimalSchema,
    source: z.string().regex(sourcePattern),
    source_fact_ref: z.string().regex(sourceFactRefPattern),
    observed_at: rfc3339Schema,
    created_at: rfc3339Schema,
  })
  .strict();

const alertHistorySchema = z
  .object({
    items: z.array(historyItemSchema),
    next_offset: z.number().int().nonnegative().nullable(),
  })
  .strict();

const preferenceSchema = z
  .object({
    event_type: z.enum(notificationEventTypes),
    enabled: z.boolean(),
  })
  .strict();

const preferenceSetSchema = z
  .array(preferenceSchema)
  .length(notificationEventTypes.length)
  .superRefine((preferences, context) => {
    const actual = new Set(preferences.map(({ event_type }) => event_type));
    for (const eventType of notificationEventTypes) {
      if (!actual.has(eventType)) {
        context.addIssue({
          code: "custom",
          message: "Every notification event type is required",
        });
      }
    }
  })
  .transform((preferences) =>
    notificationEventTypes.map((eventType) => ({
      event_type: eventType,
      enabled:
        preferences.find(({ event_type }) => event_type === eventType)
          ?.enabled ?? false,
    })),
  );

const replacePreferencesSchema = z
  .object({
    expected_version: z.number().int().nonnegative(),
    preferences: preferenceSetSchema,
  })
  .strict();

const preferenceResourceSchema = z
  .object({
    version: z.number().int().nonnegative(),
    preferences: preferenceSetSchema,
    delivery: z.object({ state: z.literal("unavailable") }).strict(),
  })
  .strict();

type DeepReadonly<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type PriceAlertCondition = (typeof priceAlertConditions)[number];
export type NotificationEventType = (typeof notificationEventTypes)[number];
export type PriceAlertDefinition = DeepReadonly<
  z.output<typeof definitionSchema>
>;
export type ReplacePriceAlertRequest = DeepReadonly<
  z.output<typeof replaceDefinitionSchema>
>;
export type PriceAlertResource = DeepReadonly<
  z.output<typeof alertResourceSchema>
>;
export type PriceAlertList = DeepReadonly<z.output<typeof alertListSchema>>;
export type PriceAlertHistoryItem = DeepReadonly<
  z.output<typeof historyItemSchema>
>;
export type PriceAlertHistory = DeepReadonly<
  z.output<typeof alertHistorySchema>
>;
export type NotificationPreference = DeepReadonly<
  z.output<typeof preferenceSchema>
>;
export type ReplaceNotificationPreferencesRequest = DeepReadonly<
  z.output<typeof replacePreferencesSchema>
>;
export type NotificationPreferencesResource = DeepReadonly<
  z.output<typeof preferenceResourceSchema>
>;

export class InvalidAlertContractError extends Error {
  readonly code = "invalid_alert_contract";

  constructor() {
    super("The alert contract value is invalid");
    this.name = "InvalidAlertContractError";
  }
}

function parseStrict<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): DeepReadonly<z.output<Schema>> {
  try {
    return Object.freeze(schema.parse(value)) as DeepReadonly<z.output<Schema>>;
  } catch {
    throw new InvalidAlertContractError();
  }
}

export function parsePriceAlertDefinition(
  value: unknown,
): PriceAlertDefinition {
  return parseStrict(definitionSchema, value);
}

export function parseReplacePriceAlertRequest(
  value: unknown,
): ReplacePriceAlertRequest {
  return parseStrict(replaceDefinitionSchema, value);
}

export function parsePriceAlertResource(value: unknown): PriceAlertResource {
  return parseStrict(alertResourceSchema, value);
}

export function parsePriceAlertList(value: unknown): PriceAlertList {
  return parseStrict(alertListSchema, value);
}

export function parsePriceAlertHistoryItem(
  value: unknown,
): PriceAlertHistoryItem {
  return parseStrict(historyItemSchema, value);
}

export function parsePriceAlertHistory(value: unknown): PriceAlertHistory {
  return parseStrict(alertHistorySchema, value);
}

export function parseReplaceNotificationPreferencesRequest(
  value: unknown,
): ReplaceNotificationPreferencesRequest {
  return parseStrict(replacePreferencesSchema, value);
}

export function parseNotificationPreferencesResource(
  value: unknown,
): NotificationPreferencesResource {
  return parseStrict(preferenceResourceSchema, value);
}

export function parseAlertIdempotencyKey(
  rawHeaders: readonly string[],
): string {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      const value = rawHeaders[index + 1];
      if (value !== undefined) {
        values.push(value);
      }
    }
  }
  if (values.length !== 1 || !uuidPattern.test(values[0] ?? "")) {
    throw new InvalidAlertContractError();
  }
  return values[0] ?? "";
}

export function digestPriceAlertCreate(value: unknown): string {
  const definition = parsePriceAlertDefinition(value);
  return createHash("sha256")
    .update(digestDomain, "utf8")
    .update(
      JSON.stringify([
        PRICE_ALERT_CREATE_DIGEST_VERSION,
        definition.asset_key,
        definition.condition,
        definition.threshold_decimal,
        definition.expires_at,
      ]),
      "utf8",
    )
    .digest("hex");
}
