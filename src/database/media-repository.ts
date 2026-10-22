import type { Pool } from "pg";
import { z } from "zod";

import {
  ipfsCidPatternSource,
  storedMediaKinds,
} from "../features/media/media-contract.js";
import {
  MediaIdempotencyConflictError,
  MediaStorageUnavailableError,
  type MediaObject,
  type MediaObjectMetadata,
  type MediaStorage,
  type PutMediaObjectInput,
} from "../features/media/media-storage.js";

/**
 * PostgreSQL `MediaStorage` (Decision 0095): `media_objects` keeps the
 * re-encoded WebP bytes with their metadata. Rows are immutable.
 */

const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const metadataRowSchema = z
  .object({
    media_id: uuidSchema,
    owner_user_id: uuidSchema.nullable(),
    kind: z.enum(storedMediaKinds),
    content_type: z.literal("image/webp"),
    width: z.number().int().min(1),
    height: z.number().int().min(1),
    sha256: sha256Schema,
    request_sha256: sha256Schema,
    created_at: z.date(),
    // Decision 0173.
    ipfs_cid: z.string().regex(new RegExp(ipfsCidPatternSource)).nullable(),
  })
  .strict();

const metadataColumns = `
  media_id, owner_user_id, kind, content_type, width, height, sha256,
  request_sha256, created_at, ipfs_cid
`;

function toMetadata(row: unknown): MediaObjectMetadata & {
  readonly requestSha256: string;
} {
  const parsed = metadataRowSchema.parse(row);
  return Object.freeze({
    mediaId: parsed.media_id,
    ownerUserId: parsed.owner_user_id,
    kind: parsed.kind,
    contentType: parsed.content_type,
    width: parsed.width,
    height: parsed.height,
    sha256: parsed.sha256,
    requestSha256: parsed.request_sha256,
    createdAt: parsed.created_at.toISOString(),
    ipfsCid: parsed.ipfs_cid,
  });
}

function pickMetadata(row: Record<string, unknown>): Record<string, unknown> {
  return {
    media_id: row["media_id"],
    owner_user_id: row["owner_user_id"],
    kind: row["kind"],
    content_type: row["content_type"],
    width: row["width"],
    height: row["height"],
    sha256: row["sha256"],
    request_sha256: row["request_sha256"],
    created_at: row["created_at"],
    ipfs_cid: row["ipfs_cid"],
  };
}

export function createPostgresMediaRepository(pool: Pool): MediaStorage {
  async function findByKey(
    ownerUserId: string,
    idempotencyKey: string,
  ): Promise<
    (MediaObjectMetadata & { readonly requestSha256: string }) | null
  > {
    const result = await pool.query<Record<string, unknown>>({
      text: `
        select ${metadataColumns}
        from public.media_objects
        where owner_user_id = $1 and idempotency_key = $2
        limit 1
      `,
      values: [ownerUserId, idempotencyKey],
    });
    const row = result.rows[0];
    return row === undefined ? null : toMetadata(row);
  }

  return Object.freeze({
    async put(input: PutMediaObjectInput): Promise<MediaObjectMetadata> {
      let inserted: Record<string, unknown> | undefined;
      try {
        const result = await pool.query<Record<string, unknown>>({
          text: `
            insert into public.media_objects (
              media_id, owner_user_id, kind, content_type, bytes, width,
              height, sha256, idempotency_key, request_sha256, ipfs_cid
            )
            values ($1, $2, $3, 'image/webp', $4, $5, $6, $7, $8, $9, $10)
            on conflict (owner_user_id, idempotency_key) do nothing
            returning ${metadataColumns}
          `,
          values: [
            uuidSchema.parse(input.mediaId),
            uuidSchema.parse(input.ownerUserId),
            input.kind,
            input.bytes,
            input.width,
            input.height,
            sha256Schema.parse(input.sha256),
            uuidSchema.parse(input.idempotencyKey),
            sha256Schema.parse(input.requestSha256),
            input.ipfsCid ?? null,
          ],
        });
        inserted = result.rows[0];
        if (inserted !== undefined) {
          return toMetadata(pickMetadata(inserted));
        }
        const earlier = await findByKey(
          input.ownerUserId,
          input.idempotencyKey,
        );
        if (earlier === null) {
          throw new MediaStorageUnavailableError();
        }
        if (
          earlier.kind !== input.kind ||
          earlier.requestSha256 !== input.requestSha256
        ) {
          throw new MediaIdempotencyConflictError();
        }
        return earlier;
      } catch (error) {
        if (
          error instanceof MediaIdempotencyConflictError ||
          error instanceof MediaStorageUnavailableError
        ) {
          throw error;
        }
        throw new MediaStorageUnavailableError();
      }
    },

    async findByIdempotencyKey(input: {
      readonly ownerUserId: string;
      readonly idempotencyKey: string;
    }): Promise<
      (MediaObjectMetadata & { readonly requestSha256: string }) | null
    > {
      try {
        return await findByKey(
          uuidSchema.parse(input.ownerUserId),
          uuidSchema.parse(input.idempotencyKey),
        );
      } catch {
        throw new MediaStorageUnavailableError();
      }
    },

    async get(mediaId: string): Promise<MediaObject | null> {
      try {
        const result = await pool.query<Record<string, unknown>>({
          text: `
            select ${metadataColumns}, bytes
            from public.media_objects
            where media_id = $1
            limit 1
          `,
          values: [uuidSchema.parse(mediaId)],
        });
        const row = result.rows[0];
        if (row === undefined) {
          return null;
        }
        const bytes = row["bytes"];
        if (!Buffer.isBuffer(bytes)) {
          throw new MediaStorageUnavailableError();
        }
        return Object.freeze({ ...toMetadata(pickMetadata(row)), bytes });
      } catch {
        throw new MediaStorageUnavailableError();
      }
    },

    async getMetadata(mediaId: string): Promise<MediaObjectMetadata | null> {
      try {
        const result = await pool.query<Record<string, unknown>>({
          text: `
            select ${metadataColumns}
            from public.media_objects
            where media_id = $1
            limit 1
          `,
          values: [uuidSchema.parse(mediaId)],
        });
        const row = result.rows[0];
        return row === undefined ? null : toMetadata(row);
      } catch {
        throw new MediaStorageUnavailableError();
      }
    },
    async findProjectNftImageByCid(input: {
      readonly ownerUserId: string;
      readonly cid: string;
    }): Promise<MediaObjectMetadata | null> {
      try {
        const result = await pool.query<Record<string, unknown>>({
          text: `
            select ${metadataColumns}
            from public.media_objects
            where owner_user_id = $1 and kind = 'project_nft_image'
              and ipfs_cid = $2
            order by created_at, media_id
            limit 1
          `,
          values: [uuidSchema.parse(input.ownerUserId), input.cid],
        });
        const row = result.rows[0];
        return row === undefined ? null : toMetadata(row);
      } catch {
        throw new MediaStorageUnavailableError();
      }
    },
  });
}
