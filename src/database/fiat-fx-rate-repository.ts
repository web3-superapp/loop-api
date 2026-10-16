import type { Pool } from "pg";

import { normalizeDecimalString } from "../features/market/market-contract.js";
import { toIsoString } from "./v2-command-support.js";

/**
 * Decision 0149: `fiat_fx_rates` (migration 000088). Written by the
 * `fiat_fx_rate` worker lane, read by the net worth history `fiat` block.
 */

export type FiatFxRateQuality = "fresh" | "stale";

export interface FiatFxRateRecord {
  readonly base: string;
  readonly quote: string;
  /** Canonical positive decimal string. */
  readonly rate: string;
  readonly source: string;
  /** `YYYY-MM-DD`. */
  readonly providerAsOf: string;
  /** ISO timestamp of the fetch. */
  readonly fetchedAt: string;
  readonly quality: FiatFxRateQuality;
}

export interface FiatFxRateRepository {
  /** Upserts on (base, quote, source, providerAsOf). */
  recordRate(record: FiatFxRateRecord): Promise<void>;
  /** Newest provider date (then newest fetch) for the pair, or null. */
  readLatest(input: {
    readonly base: string;
    readonly quote: string;
  }): Promise<FiatFxRateRecord | null>;
}

export class FiatFxRateUnavailableError extends Error {
  readonly code = "fiat_fx_rate_unavailable";

  constructor() {
    super("The fiat FX rate row is malformed");
    this.name = "FiatFxRateUnavailableError";
  }
}

interface RateRow {
  readonly base: string;
  readonly quote: string;
  readonly rate: string;
  readonly source: string;
  readonly provider_as_of: string;
  readonly fetched_at: Date | string;
  readonly quality: string;
}

export function createPostgresFiatFxRateRepository(
  pool: Pool,
): FiatFxRateRepository {
  return Object.freeze({
    async recordRate(record: FiatFxRateRecord): Promise<void> {
      await pool.query({
        name: "fiat_fx_rates_record",
        text: `
          insert into public.fiat_fx_rates
            (base, quote, source, provider_as_of, rate, fetched_at, quality)
          values ($1, $2, $3, $4::date, $5::numeric, $6::timestamptz, $7)
          on conflict (base, quote, source, provider_as_of) do update
            set rate = excluded.rate,
                fetched_at = excluded.fetched_at,
                quality = excluded.quality
            where public.fiat_fx_rates.fetched_at <= excluded.fetched_at
        `,
        values: [
          record.base,
          record.quote,
          record.source,
          record.providerAsOf,
          record.rate,
          record.fetchedAt,
          record.quality,
        ],
      });
    },
    async readLatest(input: {
      readonly base: string;
      readonly quote: string;
    }): Promise<FiatFxRateRecord | null> {
      const result = await pool.query<RateRow>({
        name: "fiat_fx_rates_latest",
        text: `
          select base, quote, rate::text as rate, source,
                 to_char(provider_as_of, 'YYYY-MM-DD') as provider_as_of,
                 fetched_at, quality
            from public.fiat_fx_rates
           where base = $1 and quote = $2
           order by provider_as_of desc, fetched_at desc
           limit 1
        `,
        values: [input.base, input.quote],
      });
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      if (row.quality !== "fresh" && row.quality !== "stale") {
        throw new FiatFxRateUnavailableError();
      }
      return Object.freeze({
        base: row.base,
        quote: row.quote,
        rate: normalizeDecimalString(row.rate),
        source: row.source,
        providerAsOf: row.provider_as_of,
        fetchedAt: toIsoString(row.fetched_at),
        quality: row.quality,
      });
    },
  });
}
