import type { Pool } from "pg";
import { z } from "zod";

import {
  marketSources,
  type MarketSource,
} from "../features/market/market-contract.js";

/**
 * Storage for normalised market Provider facts (Decision 0034).
 *
 * A row records what one Provider reported for one subject at `fetchedAt`
 * with the TTL the product assigned and the SHA-256 digest of the raw body.
 * The repository never decides freshness; `market-fact-service` does, so the
 * same row can be `fresh`, `stale`, or expired depending on the reader's
 * policy.
 */

const subjectKeyPattern = /^[a-z][a-z0-9]*:[A-Za-z0-9:._-]{1,160}$/;
const factKindPattern = /^[a-z][a-z0-9_]{0,63}$/;

const rowSchema = z
  .object({
    subject_key: z.string().regex(subjectKeyPattern),
    fact_kind: z.string().regex(factKindPattern),
    source: z.enum(marketSources),
    value: z.record(z.string(), z.unknown()),
    raw_digest: z.string().regex(/^[0-9a-f]{64}$/),
    fetched_at: z.date(),
    ttl_seconds: z.number().int().min(1).max(86_400),
  })
  .strict();

const communityRowSchema = z
  .object({
    community_id: z.string().uuid(),
    name: z.string().min(1).max(40),
    slug: z.string().min(3).max(32),
    member_count: z.number().int().min(0),
    verification_status: z.string().min(1).max(32),
  })
  .strict();

export interface MarketFactCacheRecord {
  readonly subjectKey: string;
  readonly factKind: string;
  readonly source: MarketSource;
  readonly value: Readonly<Record<string, unknown>>;
  readonly rawDigest: string;
  readonly fetchedAt: string;
  readonly ttlSeconds: number;
}

export interface PutMarketFactInput {
  readonly subjectKey: string;
  readonly factKind: string;
  readonly source: MarketSource;
  readonly value: Readonly<Record<string, unknown>>;
  readonly rawDigest: string;
  readonly fetchedAt: string;
  readonly ttlSeconds: number;
}

export interface BoundCommunityRecord {
  readonly communityId: string;
  readonly name: string;
  readonly slug: string;
  readonly memberCount: number;
  readonly verificationStatus: string;
}

export interface MarketFactCacheRepository {
  get(
    subjectKey: string,
    factKind: string,
    source: MarketSource,
  ): Promise<MarketFactCacheRecord | null>;
  put(input: PutMarketFactInput): Promise<MarketFactCacheRecord>;
  /**
   * The verified community bound to an asset, if any. Community binding is a
   * PostgreSQL fact written by the community module (Decision 0031); the
   * market surface only reads it.
   */
  findVerifiedCommunityByAssetId(
    assetId: string,
  ): Promise<BoundCommunityRecord | null>;
}

export class MarketFactCacheUnavailableError extends Error {
  readonly code = "market_fact_cache_unavailable";

  constructor() {
    super("The market fact cache repository is unavailable");
    this.name = "MarketFactCacheUnavailableError";
  }
}

const columns = `
  subject_key, fact_kind, source, value, raw_digest, fetched_at, ttl_seconds
`;

function mapRow(row: unknown): MarketFactCacheRecord {
  const parsed = rowSchema.parse(row);
  return Object.freeze({
    subjectKey: parsed.subject_key,
    factKind: parsed.fact_kind,
    source: parsed.source,
    value: Object.freeze({ ...parsed.value }),
    rawDigest: parsed.raw_digest,
    fetchedAt: parsed.fetched_at.toISOString(),
    ttlSeconds: parsed.ttl_seconds,
  });
}

export function createPostgresMarketFactCacheRepository(
  pool: Pool,
): MarketFactCacheRepository {
  return Object.freeze({
    async get(
      subjectKey: string,
      factKind: string,
      source: MarketSource,
    ): Promise<MarketFactCacheRecord | null> {
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select ${columns}
          from public.market_fact_cache
          where subject_key = $1 and fact_kind = $2 and source = $3
          limit 1
        `,
        values: [subjectKey, factKind, source],
      });
      const row = result.rows[0];
      return row === undefined ? null : mapRow(row);
    },

    async put(input: PutMarketFactInput): Promise<MarketFactCacheRecord> {
      const result = await pool.query<Record<string, unknown>>({
        text: `
          insert into public.market_fact_cache (
            subject_key, fact_kind, source, value, raw_digest, fetched_at, ttl_seconds
          )
          values ($1, $2, $3, $4::jsonb, $5, $6::timestamptz, $7)
          on conflict (subject_key, fact_kind, source) do update set
            value = excluded.value,
            raw_digest = excluded.raw_digest,
            fetched_at = excluded.fetched_at,
            ttl_seconds = excluded.ttl_seconds,
            updated_at = clock_timestamp()
          returning ${columns}
        `,
        values: [
          input.subjectKey,
          input.factKind,
          input.source,
          JSON.stringify(input.value),
          input.rawDigest,
          input.fetchedAt,
          input.ttlSeconds,
        ],
      });
      const row = result.rows[0];
      if (row === undefined) {
        throw new MarketFactCacheUnavailableError();
      }
      return mapRow(row);
    },

    async findVerifiedCommunityByAssetId(
      assetId: string,
    ): Promise<BoundCommunityRecord | null> {
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select community_id, name, slug, member_count, verification_status
          from public.communities
          where bound_asset_key = $1 and verification_status = 'verified'
          order by member_count desc, created_at asc
          limit 1
        `,
        values: [assetId],
      });
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      const parsed = communityRowSchema.parse(row);
      return Object.freeze({
        communityId: parsed.community_id,
        name: parsed.name,
        slug: parsed.slug,
        memberCount: parsed.member_count,
        verificationStatus: parsed.verification_status,
      });
    },
  });
}

function unavailable(): Promise<never> {
  return Promise.reject(new MarketFactCacheUnavailableError());
}

export function createUnavailableMarketFactCacheRepository(): MarketFactCacheRepository {
  return Object.freeze({
    get: unavailable,
    put: unavailable,
    findVerifiedCommunityByAssetId: unavailable,
  });
}
