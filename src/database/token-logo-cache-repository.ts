import type { Pool } from "pg";
import { z } from "zod";

import {
  tokenLogoSources,
  type TokenLogoSource,
} from "../features/market/token-logo.js";
import { insertAdminAuditRow } from "./admin-repository.js";
import { withV2Transaction } from "./v2-command-support.js";

/**
 * Storage of the token logo proxy (Decision 0089). The repository stores and
 * returns rows; `token-logo-proxy` decides freshness and what to publish.
 *
 * Decision 0161: a row may be an operator's manual picture (`source =
 * manual`, no upstream URL). An automatic write (`put`) never replaces a
 * manual row — the guard is in the upsert itself, so a refetch racing a
 * console upload cannot win. Only `putManual` / `clearManual` touch manual
 * rows, each in one transaction with its `admin_audit_log` row.
 */

/** Every `source` a stored row may carry (the projection never says manual). */
export const tokenLogoCacheSources = Object.freeze([
  ...tokenLogoSources,
  "manual",
] as const);
export type TokenLogoCacheSource = (typeof tokenLogoCacheSources)[number];

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
  readonly source: TokenLogoCacheSource | null;
  readonly sourceUrl: string | null;
  /** The top upstream candidate at fetch time; `null` for a manual row. */
  readonly candidateUrl: string | null;
  readonly fetchedAt: string;
  readonly expiresAt: string;
}

/** An automatic (upstream) write: never a manual row. */
export interface TokenLogoCacheAutomaticRecord extends TokenLogoCacheRecord {
  readonly source: TokenLogoSource | null;
  readonly candidateUrl: string;
}

export interface TokenLogoAuditInput {
  readonly actor: string;
  readonly actorAccountId: string | null;
  readonly requestId: string;
}

export interface TokenLogoAuditRef {
  readonly auditId: string;
  readonly seq: number;
  readonly at: string;
}

export interface TokenLogoManualPicture {
  readonly chainId: string;
  readonly address: string;
  readonly bytes: Buffer;
  readonly contentType: TokenLogoContentType;
  readonly etag: string;
  readonly at: string;
}

/** Audit `before` / `after` of a manual write: never the bytes. */
export interface TokenLogoAuditSnapshot {
  readonly status: TokenLogoCacheStatus;
  readonly source: TokenLogoCacheSource | null;
  readonly etag: string | null;
  readonly byteLength: number | null;
}

/**
 * `expires_at` of a manual row: it never expires; the proxy also treats
 * `source = manual` as always fresh, whatever the timestamp says.
 */
export const tokenLogoNeverExpires = "9999-12-31T23:59:59.999Z";

export const tokenLogoAuditActions = Object.freeze({
  override: "market.logo.override",
  clear: "market.logo.override_clear",
} as const);

export interface TokenLogoCacheRepository {
  get(chainId: string, address: string): Promise<TokenLogoCacheRecord | null>;
  /** Upsert of an upstream result; a manual row is left untouched. */
  put(record: TokenLogoCacheAutomaticRecord): Promise<void>;
  /** The rows of `chainId` (no bytes needed) whose address is in the list. */
  listStates?(
    chainId: string,
    addresses: readonly string[],
  ): Promise<ReadonlyMap<string, TokenLogoCacheRecord>>;
  /** Decision 0161 §3: an operator's picture, kept until cleared. */
  putManual?(
    picture: TokenLogoManualPicture,
    audit: TokenLogoAuditInput,
  ): Promise<{
    readonly record: TokenLogoCacheRecord;
    readonly before: TokenLogoCacheRecord | null;
    readonly audit: TokenLogoAuditRef;
  }>;
  /** Removes a manual row; `null` when the row is absent or not manual. */
  clearManual?(
    chainId: string,
    address: string,
    audit: TokenLogoAuditInput,
  ): Promise<{
    readonly before: TokenLogoCacheRecord;
    readonly audit: TokenLogoAuditRef;
  } | null>;
}

export function tokenLogoAuditSnapshot(
  record: TokenLogoCacheRecord | null,
): TokenLogoAuditSnapshot | null {
  if (record === null) {
    return null;
  }
  return Object.freeze({
    status: record.status,
    source: record.source,
    etag: record.etag,
    byteLength: record.bytes === null ? null : record.bytes.length,
  });
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
    source: z.enum(tokenLogoCacheSources).nullable(),
    source_url: z.string().nullable(),
    candidate_url: z.string().min(1).nullable(),
    fetched_at: z.date(),
    expires_at: z.date(),
  })
  .strict();

const columns = `
  chain_id, address, status, bytes, content_type, etag, source, source_url,
  candidate_url, fetched_at, expires_at
`;

function unavailableError(): Error {
  return new TokenLogoCacheUnavailableError();
}

function mapRow(row: unknown): TokenLogoCacheRecord {
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
}

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
      return row === undefined ? null : mapRow(row);
    },

    async listStates(
      chainId: string,
      addresses: readonly string[],
    ): Promise<ReadonlyMap<string, TokenLogoCacheRecord>> {
      const rows = new Map<string, TokenLogoCacheRecord>();
      if (addresses.length === 0) {
        return rows;
      }
      // The bytes are not needed to decide freshness; `null` keeps the
      // pre-warm pass from reading every picture.
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select chain_id, address, status, null::bytea as bytes,
            content_type, etag, source, source_url, candidate_url,
            fetched_at, expires_at
          from public.token_logo_cache
          where chain_id = $1 and address = any($2::text[])
        `,
        values: [chainId, [...addresses]],
      });
      for (const raw of result.rows) {
        const record = mapRow(raw);
        rows.set(record.address, record);
      }
      return rows;
    },

    async putManual(
      picture: TokenLogoManualPicture,
      audit: TokenLogoAuditInput,
    ) {
      return withV2Transaction(pool, unavailableError, async (client) => {
        const previous = await client.query<Record<string, unknown>>({
          text: `
            select ${columns}
            from public.token_logo_cache
            where chain_id = $1 and address = $2
            for update
          `,
          values: [picture.chainId, picture.address],
        });
        const beforeRow = previous.rows[0];
        const before = beforeRow === undefined ? null : mapRow(beforeRow);
        const written = await client.query<Record<string, unknown>>({
          text: `
            insert into public.token_logo_cache (
              chain_id, address, status, bytes, content_type, etag, source,
              source_url, candidate_url, fetched_at, expires_at
            )
            values ($1, $2, 'found', $3, $4, $5, 'manual', null, null,
              $6::timestamptz, $7::timestamptz)
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
            returning ${columns}
          `,
          values: [
            picture.chainId,
            picture.address,
            picture.bytes,
            picture.contentType,
            picture.etag,
            picture.at,
            tokenLogoNeverExpires,
          ],
        });
        const record = mapRow(written.rows[0]);
        const auditRow = await insertAdminAuditRow(client, {
          actor: audit.actor,
          actorAccountId: audit.actorAccountId,
          action: tokenLogoAuditActions.override,
          targetType: "token_logo",
          targetId: `${picture.chainId}/${picture.address}`,
          before: tokenLogoAuditSnapshot(before),
          after: tokenLogoAuditSnapshot(record),
          requestId: audit.requestId,
        });
        return {
          record,
          before,
          audit: Object.freeze({
            auditId: auditRow.auditId,
            seq: auditRow.seq,
            at: auditRow.at,
          }),
        };
      });
    },

    async clearManual(
      chainId: string,
      address: string,
      audit: TokenLogoAuditInput,
    ) {
      return withV2Transaction(pool, unavailableError, async (client) => {
        const removed = await client.query<Record<string, unknown>>({
          text: `
            delete from public.token_logo_cache
            where chain_id = $1 and address = $2 and source = 'manual'
            returning ${columns}
          `,
          values: [chainId, address],
        });
        const row = removed.rows[0];
        if (row === undefined) {
          return null;
        }
        const before = mapRow(row);
        const auditRow = await insertAdminAuditRow(client, {
          actor: audit.actor,
          actorAccountId: audit.actorAccountId,
          action: tokenLogoAuditActions.clear,
          targetType: "token_logo",
          targetId: `${chainId}/${address}`,
          before: tokenLogoAuditSnapshot(before),
          after: null,
          requestId: audit.requestId,
        });
        return {
          before,
          audit: Object.freeze({
            auditId: auditRow.auditId,
            seq: auditRow.seq,
            at: auditRow.at,
          }),
        };
      });
    },

    async put(record: TokenLogoCacheAutomaticRecord): Promise<void> {
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
          where public.token_logo_cache.source is distinct from 'manual'
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
  return Object.freeze({
    get: unavailable,
    put: unavailable,
    listStates: unavailable,
    putManual: unavailable,
    clearManual: unavailable,
  });
}
