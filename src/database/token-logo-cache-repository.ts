import type { Pool } from "pg";
import { z } from "zod";

import {
  tokenLogoSources,
  type TokenLogoSource,
} from "../features/market/token-logo.js";

/**
 * Storage of the token logo proxy (Decision 0089). The repository stores and
 * returns rows; `token-logo-proxy` decides freshness and what to publish.
 */

export const tokenLogoCacheStatuses = Object.freeze([
  "found",
  "missing",
  "oversize",
] as const);
export type TokenLogoCacheStatus = (typeof tokenLogoCacheStatuses)[number];

export const tokenLogoContentTypes = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const);
export type TokenLogoContentType = (typeof tokenLogoContentTypes)[number];

export interface TokenLogoCacheRecord {
  readonly chainId: string;
  /** Lowercase `0x` address, or `native`. */
  readonly address: string;
  readonly status: TokenLogoCacheStatus;
  readonly bytes: Buffer | null;
  readonly contentType: TokenLogoContentType | null;
  readonly etag: string | null;
  readonly source: TokenLogoSource | null;
  readonly sourceUrl: string | null;
  readonly candidateUrl: string;
  readonly fetchedAt: string;
  readonly expiresAt: string;
}

export interface TokenLogoCacheRepository {
  get(chainId: string, address: string): Promise<TokenLogoCacheRecord | null>;
  put(record: TokenLogoCacheRecord): Promise<void>;
}

export class TokenLogoCacheUnavailableError extends Error {
  readonly code = "token_logo_cache_unavailable";

  constructor() {
    super("The token logo cache repository is unavailable");
    this.name = "TokenLogoCacheUnavailableError";
  }
}

const rowSchema = z
  .object({
    chain_id: z.string().min(1),
    address: z.string().regex(/^(0x[0-9a-f]{40}|native)$/),
    status: z.enum(tokenLogoCacheStatuses),
    bytes: z.instanceof(Buffer).nullable(),
    content_type: z.enum(tokenLogoContentTypes).nullable(),
    etag: z.string().nullable(),
    source: z.enum(tokenLogoSources).nullable(),
    source_url: z.string().nullable(),
    candidate_url: z.string().min(1),
    fetched_at: z.date(),
    expires_at: z.date(),
  })
  .strict();

const columns = `
  chain_id, address, status, bytes, content_type, etag, source, source_url,
  candidate_url, fetched_at, expires_at
`;

export function createPostgresTokenLogoCacheRepository(
  pool: Pool,
): TokenLogoCacheRepository {
  return Object.freeze({
    async get(
      chainId: string,
      address: string,
    ): Promise<TokenLogoCacheRecord | null> {
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select ${columns}
          from public.token_logo_cache
          where chain_id = $1 and address = $2
          limit 1
        `,
        values: [chainId, address],
      });
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      const parsed = rowSchema.parse(row);
      return Object.freeze({
        chainId: parsed.chain_id,
        address: parsed.address,
        status: parsed.status,
        bytes: parsed.bytes,
        contentType: parsed.content_type,
        etag: parsed.etag,
        source: parsed.source,
        sourceUrl: parsed.source_url,
        candidateUrl: parsed.candidate_url,
        fetchedAt: parsed.fetched_at.toISOString(),
        expiresAt: parsed.expires_at.toISOString(),
      });
    },

    async put(record: TokenLogoCacheRecord): Promise<void> {
      await pool.query({
        text: `
          insert into public.token_logo_cache (
            chain_id, address, status, bytes, content_type, etag, source,
            source_url, candidate_url, fetched_at, expires_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz)
          on conflict (chain_id, address) do update set
            status = excluded.status,
            bytes = excluded.bytes,
            content_type = excluded.content_type,
            etag = excluded.etag,
            source = excluded.source,
            source_url = excluded.source_url,
            candidate_url = excluded.candidate_url,
            fetched_at = excluded.fetched_at,
            expires_at = excluded.expires_at,
            updated_at = clock_timestamp()
        `,
        values: [
          record.chainId,
          record.address,
          record.status,
          record.bytes,
          record.contentType,
          record.etag,
          record.source,
          record.sourceUrl,
          record.candidateUrl,
          record.fetchedAt,
          record.expiresAt,
        ],
      });
    },
  });
}

function unavailable(): Promise<never> {
  return Promise.reject(new TokenLogoCacheUnavailableError());
}

export function createUnavailableTokenLogoCacheRepository(): TokenLogoCacheRepository {
  return Object.freeze({ get: unavailable, put: unavailable });
}
