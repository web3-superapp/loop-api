import { z } from "zod";

import {
  parseSpotContract,
  type DeepReadonly,
} from "./spot-contract-support.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalNonnegativeDecimalPattern = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const canonicalPositiveDecimalPattern =
  /^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/;
const safeVersionPattern = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const safeAssetIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$/;
const maximumBindingVersion = 9_223_372_036_854_775_807n;

const uuidSchema = z.string().regex(uuidPattern);
const rfc3339Schema = z.string().max(64).datetime({ offset: true });
const safeVersionSchema = z.string().regex(safeVersionPattern);
const assetDisplayIdentitySchema = z.string().regex(safeAssetIdentityPattern);
const positiveDecimalSchema = z
  .string()
  .max(128)
  .regex(canonicalPositiveDecimalPattern);
const nonnegativeDecimalSchema = z
  .string()
  .max(128)
  .regex(canonicalNonnegativeDecimalPattern);
const bindingVersionSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= maximumBindingVersion);

function exactDecimalSumEquals(
  total: string,
  available: string,
  hold: string,
): boolean {
  const parts = [total, available, hold].map((value) => {
    const point = value.indexOf(".");
    return {
      coefficient: BigInt(point === -1 ? value : value.replace(".", "")),
      scale: point === -1 ? 0 : value.length - point - 1,
    };
  });
  const scale = Math.max(...parts.map((part) => part.scale));
  const scaled = parts.map(
    (part) => part.coefficient * 10n ** BigInt(scale - part.scale),
  );
  const [scaledTotal, scaledAvailable, scaledHold] = scaled;
  return (
    scaledTotal !== undefined &&
    scaledAvailable !== undefined &&
    scaledHold !== undefined &&
    scaledTotal === scaledAvailable + scaledHold
  );
}

function compareExactUnsignedDecimals(left: string, right: string): number {
  const parts = [left, right].map((value) => {
    const point = value.indexOf(".");
    return {
      coefficient: BigInt(point === -1 ? value : value.replace(".", "")),
      scale: point === -1 ? 0 : value.length - point - 1,
    };
  });
  const scale = Math.max(...parts.map((part) => part.scale));
  const [scaledLeft, scaledRight] = parts.map(
    (part) => part.coefficient * 10n ** BigInt(scale - part.scale),
  );
  if (scaledLeft === undefined || scaledRight === undefined) {
    return 0;
  }
  return scaledLeft < scaledRight ? -1 : scaledLeft > scaledRight ? 1 : 0;
}

const sourceSchema = z
  .object({
    provider: z.literal("hyperliquid"),
    network: z.literal("testnet"),
    metadata_version: safeVersionSchema,
    fetched_at: rfc3339Schema,
    expires_at: rfc3339Schema,
  })
  .strict()
  .refine(
    (source) => Date.parse(source.fetched_at) < Date.parse(source.expires_at),
  );

const marketSummarySchema = z
  .object({
    market_id: uuidSchema,
    state: z.enum(["enabled", "disabled"]),
    base_display_identity: assetDisplayIdentitySchema,
    quote_display_identity: assetDisplayIdentitySchema,
    base_size_decimals: z.number().int().min(0).max(18),
  })
  .strict()
  .refine(
    (market) => market.base_display_identity !== market.quote_display_identity,
  );

const capabilitySchema = z.enum(["available", "unavailable"]);

const configSchema = z
  .object({
    network: z.literal("testnet"),
    markets: z.array(marketSummarySchema).max(128),
    capabilities: z
      .object({
        market_facts: capabilitySchema,
        balances: capabilitySchema,
        intent_prepare: capabilitySchema,
        intent_submit: capabilitySchema,
        agent_authorization: capabilitySchema,
      })
      .strict(),
    review_policy: z
      .object({
        execution: z.literal("aggressive_limit_ioc"),
        default_max_slippage_bps: z.number().int().min(0).max(10_000),
        maximum_max_slippage_bps: z.number().int().min(0).max(10_000),
        review_ttl_ms: z.number().int().min(1_000).max(60_000),
      })
      .strict()
      .refine(
        (policy) =>
          policy.default_max_slippage_bps <= policy.maximum_max_slippage_bps,
      ),
    source: sourceSchema,
  })
  .strict()
  .superRefine((config, context) => {
    const marketIds = new Set<string>();
    for (const market of config.markets) {
      if (marketIds.has(market.market_id)) {
        context.addIssue({ code: "custom", path: ["markets"] });
        return;
      }
      marketIds.add(market.market_id);
    }
  });

const bookLevelSchema = z
  .object({
    price: positiveDecimalSchema,
    size: positiveDecimalSchema,
  })
  .strict();

const optionalPositiveFactSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unavailable") }).strict(),
  z
    .object({ state: z.literal("available"), value: positiveDecimalSchema })
    .strict(),
]);

const marketFactsSchema = z
  .object({
    market_id: uuidSchema,
    enabled: z.boolean(),
    base_display_identity: assetDisplayIdentitySchema,
    quote_display_identity: assetDisplayIdentitySchema,
    base_size_decimals: z.number().int().min(0).max(18),
    book: z
      .object({
        best_bid: bookLevelSchema,
        best_ask: bookLevelSchema,
        observed_at: rfc3339Schema,
      })
      .strict(),
    limits: z
      .object({
        minimum_base_size: optionalPositiveFactSchema,
        minimum_quote_notional: optionalPositiveFactSchema,
      })
      .strict(),
    source: sourceSchema,
  })
  .strict()
  .superRefine((facts, context) => {
    if (
      !facts.enabled ||
      facts.base_display_identity === facts.quote_display_identity
    ) {
      context.addIssue({ code: "custom" });
    }
    if (
      compareExactUnsignedDecimals(
        facts.book.best_bid.price,
        facts.book.best_ask.price,
      ) >= 0
    ) {
      context.addIssue({ code: "custom", path: ["book"] });
    }
    const observedAt = Date.parse(facts.book.observed_at);
    if (
      observedAt > Date.parse(facts.source.fetched_at) ||
      observedAt >= Date.parse(facts.source.expires_at)
    ) {
      context.addIssue({ code: "custom", path: ["book", "observed_at"] });
    }
  });

const balanceItemSchema = z
  .object({
    asset_id: uuidSchema,
    display_identity: assetDisplayIdentitySchema,
    total: nonnegativeDecimalSchema,
    available: nonnegativeDecimalSchema,
    hold: nonnegativeDecimalSchema,
  })
  .strict();

const balancesSchema = z
  .object({
    binding_version: bindingVersionSchema,
    account_kind: z.literal("master"),
    items: z.array(balanceItemSchema).max(512),
    source: sourceSchema,
  })
  .strict()
  .superRefine((balances, context) => {
    const ids = new Set<string>();
    for (const item of balances.items) {
      if (ids.has(item.asset_id)) {
        context.addIssue({ code: "custom", path: ["items"] });
        return;
      }
      ids.add(item.asset_id);
      if (!exactDecimalSumEquals(item.total, item.available, item.hold)) {
        context.addIssue({
          code: "custom",
          path: ["items", item.asset_id],
        });
        return;
      }
    }
  });

export type SpotConfigResource = DeepReadonly<z.output<typeof configSchema>>;
export type SpotMarketFactsResource = DeepReadonly<
  z.output<typeof marketFactsSchema>
>;
export type SpotBalancesResource = DeepReadonly<
  z.output<typeof balancesSchema>
>;

export function parseSpotMarketId(value: unknown): string {
  return parseSpotContract(uuidSchema, value);
}

export function parseSpotConfigResource(value: unknown): SpotConfigResource {
  return parseSpotContract(configSchema, value);
}

export function parseSpotMarketFactsResource(
  value: unknown,
): SpotMarketFactsResource {
  return parseSpotContract(marketFactsSchema, value);
}

export function parseSpotBalancesResource(
  value: unknown,
): SpotBalancesResource {
  return parseSpotContract(balancesSchema, value);
}
