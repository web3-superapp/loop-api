import { z } from "zod";

import {
  InvalidMarketDecimalError,
  normalizeDecimalString,
} from "../../features/market/market-contract.js";
import {
  InvalidChainIdentityError,
  normalizeEvmAddress,
} from "../../features/chain/chain-contract.js";
import type {
  CandlesProvider,
  NewPoolSnapshot,
  NewPoolsSnapshot,
  OhlcvCandle,
  OhlcvReadOptions,
  OhlcvTimeframe,
  PoolOhlcvSnapshot,
  PoolTradeSnapshot,
  PoolTradesSnapshot,
  ProviderObservation,
  ProviderReadOptions,
} from "./market-data-provider.js";
import {
  createProviderHttpKernel,
  createRateLimiter,
  malformed,
  nodeProviderFetch,
  type ProviderFetch,
  type ProviderHttpKernel,
} from "./provider-http.js";

/**
 * GeckoTerminal adapter (Decision 0034; provider-lock
 * `geckoterminal_service`, PENDING commercial terms).
 *
 * Implemented so the OHLCV, new-pools, and trades surfaces have a concrete
 * shape, but constructed only when `MARKET_PROVIDER_GECKOTERMINAL_ENABLED` is
 * true, which defaults to false until the terms gate is passed. The public
 * limit is 30 requests per minute; the throttle never exceeds it.
 */

export const geckoterminalBaseUrl = "https://api.geckoterminal.com/api/v2";
export const geckoterminalDocumentedRateLimitPerMinute = 30;
export const geckoterminalNetwork = "bsc";
const acceptHeader = "application/json;version=20230302";

const numeric = z.union([z.string(), z.number()]);

const ohlcvResponseSchema = z
  .object({
    data: z
      .object({
        attributes: z
          .object({
            ohlcv_list: z.array(z.array(numeric.nullable()).length(6)),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const newPoolsResponseSchema = z
  .object({
    data: z.array(
      z
        .object({
          attributes: z
            .object({
              address: z.string(),
              name: z.string().max(128),
              pool_created_at: z.string().nullable().optional(),
              reserve_in_usd: numeric.nullable().optional(),
              volume_usd: z
                .object({ h24: numeric.nullable().optional() })
                .passthrough()
                .nullable()
                .optional(),
            })
            .passthrough(),
          relationships: z
            .object({
              base_token: z
                .object({ data: z.object({ id: z.string() }).passthrough() })
                .passthrough()
                .optional(),
              quote_token: z
                .object({ data: z.object({ id: z.string() }).passthrough() })
                .passthrough()
                .optional(),
              dex: z
                .object({ data: z.object({ id: z.string() }).passthrough() })
                .passthrough()
                .optional(),
            })
            .passthrough()
            .optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const tradesResponseSchema = z
  .object({
    data: z.array(
      z
        .object({
          attributes: z
            .object({
              block_number: numeric,
              tx_hash: z.string(),
              block_timestamp: z.string(),
              kind: z.enum(["buy", "sell"]),
              from_token_amount: numeric,
              to_token_amount: numeric,
              price_from_in_usd: numeric.nullable().optional(),
              price_to_in_usd: numeric.nullable().optional(),
              volume_in_usd: numeric.nullable().optional(),
            })
            .passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

function decimal(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return malformed();
  }
  try {
    return normalizeDecimalString(value);
  } catch (error) {
    if (error instanceof InvalidMarketDecimalError) {
      return malformed();
    }
    throw error;
  }
}

function requiredDecimal(value: string | number | null | undefined): string {
  const result = decimal(value);
  return result === null ? malformed() : result;
}

function epochSeconds(value: string | number | null): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,11}$/.test(value)) {
    return malformed();
  }
  return new Date(Number.parseInt(value, 10) * 1_000).toISOString();
}

function timestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return malformed();
  }
  return new Date(parsed).toISOString();
}

function addressFromTokenId(id: string | undefined): string | null {
  if (id === undefined) {
    return null;
  }
  const match = /^bsc_(0x[0-9a-fA-F]{40})$/.exec(id);
  if (match === null || match[1] === undefined) {
    return null;
  }
  return normalizeEvmAddress(match[1]);
}

function address(value: string): string {
  try {
    return normalizeEvmAddress(value);
  } catch (error) {
    if (error instanceof InvalidChainIdentityError) {
      return malformed();
    }
    throw error;
  }
}

export function normalizeGeckoterminalOhlcv(
  json: unknown,
  poolAddress: string,
): PoolOhlcvSnapshot {
  const parsed = ohlcvResponseSchema.safeParse(json);
  if (!parsed.success) {
    return malformed();
  }
  const candles: OhlcvCandle[] = parsed.data.data.attributes.ohlcv_list.map(
    (row) => {
      const [time, open, high, low, close, volume] = row;
      return Object.freeze({
        openTime: epochSeconds(time ?? null),
        open: requiredDecimal(open),
        high: requiredDecimal(high),
        low: requiredDecimal(low),
        close: requiredDecimal(close),
        volume: requiredDecimal(volume),
      });
    },
  );
  candles.sort((left, right) => left.openTime.localeCompare(right.openTime));
  return Object.freeze({ poolAddress, candles: Object.freeze(candles) });
}

/** Uniswap V4 pools have no contract of their own; GeckoTerminal keys them by pool id. */
const poolIdPattern = /^0x[0-9a-fA-F]{64}$/;

export function normalizeGeckoterminalNewPools(
  json: unknown,
): NewPoolsSnapshot {
  const parsed = newPoolsResponseSchema.safeParse(json);
  if (!parsed.success) {
    return malformed();
  }
  // A 32-byte pool id is a real Provider fact, not a malformed response, but
  // it is not an address and the contract publishes pool addresses only: the
  // row is omitted and counted. Anything else that is not an address is still
  // malformed.
  const listed = parsed.data.data.filter(
    (pool) => !poolIdPattern.test(pool.attributes.address),
  );
  const omittedPoolCount = parsed.data.data.length - listed.length;
  const pools: NewPoolSnapshot[] = listed.map((pool) =>
    Object.freeze({
      poolAddress: address(pool.attributes.address),
      dexId: pool.relationships?.dex?.data.id ?? "unknown",
      name: pool.attributes.name,
      baseTokenAddress: addressFromTokenId(
        pool.relationships?.base_token?.data.id,
      ),
      quoteTokenAddress: addressFromTokenId(
        pool.relationships?.quote_token?.data.id,
      ),
      createdAt:
        pool.attributes.pool_created_at === null ||
        pool.attributes.pool_created_at === undefined
          ? null
          : timestamp(pool.attributes.pool_created_at),
      reserveUsd: decimal(pool.attributes.reserve_in_usd),
      volumeH24Usd: decimal(pool.attributes.volume_usd?.h24),
    }),
  );
  return Object.freeze({ pools: Object.freeze(pools), omittedPoolCount });
}

export function normalizeGeckoterminalTrades(
  json: unknown,
  poolAddress: string,
): PoolTradesSnapshot {
  const parsed = tradesResponseSchema.safeParse(json);
  if (!parsed.success) {
    return malformed();
  }
  const trades: PoolTradeSnapshot[] = parsed.data.data.map((trade) => {
    const blockNumber = requiredDecimal(trade.attributes.block_number);
    if (!/^(0|[1-9][0-9]*)$/.test(blockNumber)) {
      return malformed();
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(trade.attributes.tx_hash)) {
      return malformed();
    }
    return Object.freeze({
      transactionHash: trade.attributes.tx_hash.toLowerCase(),
      blockNumber,
      blockTimestamp: timestamp(trade.attributes.block_timestamp),
      kind: trade.attributes.kind,
      fromTokenAmount: requiredDecimal(trade.attributes.from_token_amount),
      toTokenAmount: requiredDecimal(trade.attributes.to_token_amount),
      priceFromInUsd: decimal(trade.attributes.price_from_in_usd),
      priceToInUsd: decimal(trade.attributes.price_to_in_usd),
      volumeUsd: decimal(trade.attributes.volume_in_usd),
    });
  });
  return Object.freeze({ poolAddress, trades: Object.freeze(trades) });
}

const timeframePaths: Readonly<
  Record<
    OhlcvTimeframe,
    {
      readonly path: string;
      readonly aggregate: number;
      readonly bucketMultiplier: number;
    }
  >
> = Object.freeze({
  "15m": { path: "minute", aggregate: 15, bucketMultiplier: 1 },
  "1h": { path: "hour", aggregate: 1, bucketMultiplier: 1 },
  "4h": { path: "hour", aggregate: 4, bucketMultiplier: 1 },
  "1d": { path: "day", aggregate: 1, bucketMultiplier: 1 },
  // GeckoTerminal has no weekly timeframe; daily candles are requested and
  // folded into epoch-aligned weeks locally.
  "1w": { path: "day", aggregate: 1, bucketMultiplier: 7 },
});

const weekSeconds = 604_800;

/** Folds daily candles into epoch-aligned (Thursday 00:00 UTC) weekly candles. */
export function foldDailyCandlesIntoWeeks(
  daily: readonly OhlcvCandle[],
): readonly OhlcvCandle[] {
  const buckets = new Map<
    number,
    OhlcvCandle & { volumeRaw: bigint; scale: number }
  >();
  const ordered = [...daily].sort((left, right) =>
    left.openTime.localeCompare(right.openTime),
  );
  for (const candle of ordered) {
    const seconds = Math.floor(Date.parse(candle.openTime) / 1_000);
    const bucket = seconds - (seconds % weekSeconds);
    const existing = buckets.get(bucket);
    if (existing === undefined) {
      buckets.set(bucket, {
        openTime: new Date(bucket * 1_000).toISOString(),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        volumeRaw: 0n,
        scale: 0,
      });
      continue;
    }
    buckets.set(bucket, {
      ...existing,
      high: maxDecimal(existing.high, candle.high),
      low: minDecimal(existing.low, candle.low),
      close: candle.close,
      volume: addDecimal(existing.volume, candle.volume),
    });
  }
  return Object.freeze(
    [...buckets.values()].map((bucket) =>
      Object.freeze({
        openTime: bucket.openTime,
        open: bucket.open,
        high: bucket.high,
        low: bucket.low,
        close: bucket.close,
        volume: bucket.volume,
      }),
    ),
  );
}

function decimalParts(value: string): { digits: bigint; scale: number } {
  const [whole = "0", fraction = ""] = value.split(".");
  return { digits: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function addDecimal(left: string, right: string): string {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const sum =
    a.digits * 10n ** BigInt(scale - a.scale) +
    b.digits * 10n ** BigInt(scale - b.scale);
  const text = sum.toString(10).padStart(scale + 1, "0");
  const whole = text.slice(0, text.length - scale);
  const fraction = text.slice(text.length - scale).replace(/0+$/, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

function compare(left: string, right: string): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const x = a.digits * 10n ** BigInt(scale - a.scale);
  const y = b.digits * 10n ** BigInt(scale - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

function maxDecimal(left: string, right: string): string {
  return compare(left, right) >= 0 ? left : right;
}

function minDecimal(left: string, right: string): string {
  return compare(left, right) <= 0 ? left : right;
}

export interface CreateGeckoterminalAdapterInput {
  readonly rateLimitPerMinute?: number;
  readonly fetch?: ProviderFetch;
  readonly baseUrl?: string;
  readonly now?: () => Date;
  readonly kernel?: ProviderHttpKernel;
}

export function createGeckoterminalAdapter(
  input: CreateGeckoterminalAdapterInput = {},
): CandlesProvider {
  const rateLimitPerMinute = Math.min(
    input.rateLimitPerMinute ?? geckoterminalDocumentedRateLimitPerMinute,
    geckoterminalDocumentedRateLimitPerMinute,
  );
  const kernel =
    input.kernel ??
    createProviderHttpKernel({
      fetch: input.fetch ?? nodeProviderFetch,
      rateLimiter: createRateLimiter({ capacityPerMinute: rateLimitPerMinute }),
    });
  const baseUrl = (input.baseUrl ?? geckoterminalBaseUrl).replace(/\/$/, "");
  const now = input.now ?? ((): Date => new Date());
  const headers = { accept: acceptHeader } as const;

  return Object.freeze({
    source: "geckoterminal" as const,
    async readPoolOhlcv(
      rawPoolAddress: string,
      timeframe: OhlcvTimeframe,
      limit: number,
      options: OhlcvReadOptions = {},
    ): Promise<ProviderObservation<PoolOhlcvSnapshot>> {
      const poolAddress = normalizeEvmAddress(rawPoolAddress);
      const mapping = timeframePaths[timeframe];
      const requestLimit = Math.min(limit * mapping.bucketMultiplier, 1_000);
      const tokenQuery =
        options.tokenAddress === undefined
          ? ""
          : `&token=${normalizeEvmAddress(options.tokenAddress)}`;
      const result = await kernel.requestJson({
        url: `${baseUrl}/networks/${geckoterminalNetwork}/pools/${poolAddress}/ohlcv/${mapping.path}?aggregate=${String(mapping.aggregate)}&limit=${String(requestLimit)}${tokenQuery}`,
        headers,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const snapshot = normalizeGeckoterminalOhlcv(result.json, poolAddress);
      const candles =
        mapping.bucketMultiplier === 1
          ? snapshot.candles
          : foldDailyCandlesIntoWeeks(snapshot.candles);
      return Object.freeze({
        value: Object.freeze({
          poolAddress,
          candles: Object.freeze(candles.slice(-limit)),
        }),
        source: "geckoterminal" as const,
        fetchedAt: now().toISOString(),
        rawDigest: result.rawDigest,
      });
    },

    async readNewPools(
      options: ProviderReadOptions = {},
    ): Promise<ProviderObservation<NewPoolsSnapshot>> {
      const result = await kernel.requestJson({
        url: `${baseUrl}/networks/${geckoterminalNetwork}/new_pools?page=1`,
        headers,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return Object.freeze({
        value: normalizeGeckoterminalNewPools(result.json),
        source: "geckoterminal" as const,
        fetchedAt: now().toISOString(),
        rawDigest: result.rawDigest,
      });
    },

    async readPoolTrades(
      rawPoolAddress: string,
      options: ProviderReadOptions = {},
    ): Promise<ProviderObservation<PoolTradesSnapshot>> {
      const poolAddress = normalizeEvmAddress(rawPoolAddress);
      const result = await kernel.requestJson({
        url: `${baseUrl}/networks/${geckoterminalNetwork}/pools/${poolAddress}/trades`,
        headers,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return Object.freeze({
        value: normalizeGeckoterminalTrades(result.json, poolAddress),
        source: "geckoterminal" as const,
        fetchedAt: now().toISOString(),
        rawDigest: result.rawDigest,
      });
    },
  });
}
