import type { Pool } from "pg";
import { z } from "zod";

import type {
  StreamUserIdentityRecord,
  StreamUserIdentityRepository,
} from "../features/communication/stream-user-identity.js";

/** Identity facts the Stream user projection reads (Decision 0095). */

const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

const rowSchema = z
  .object({
    owner_user_id: uuidSchema,
    alias: z.string().min(1).nullable(),
    avatar_ref: z.string().min(1).nullable(),
    public_profile_id: uuidSchema.nullable(),
  })
  .strict();

export function createPostgresStreamUserIdentityRepository(
  pool: Pool,
): StreamUserIdentityRepository {
  return Object.freeze({
    async listIdentities(
      userIds: readonly string[],
    ): Promise<readonly StreamUserIdentityRecord[]> {
      if (userIds.length === 0) {
        return Object.freeze([]);
      }
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select
            owner_user_id,
            alias,
            avatar_ref,
            case
              when profile_status = 'active' then public_profile_id
            end as public_profile_id
          from public.user_profiles
          where owner_user_id = any($1::uuid[])
        `,
        values: [userIds.map((id) => uuidSchema.parse(id))],
      });
      return Object.freeze(
        result.rows.map((row) => {
          const parsed = rowSchema.parse(row);
          return Object.freeze({
            userId: parsed.owner_user_id,
            alias: parsed.alias,
            avatarRef: parsed.avatar_ref,
            publicProfileId: parsed.public_profile_id,
          });
        }),
      );
    },

    async listActivatedUserIds(input: {
      readonly afterUserId: string | null;
      readonly limit: number;
    }): Promise<readonly string[]> {
      const limit = z.number().int().min(1).max(1_000).parse(input.limit);
      const result = await pool.query<{ owner_user_id: string }>({
        text: `
          select owner_user_id
          from public.user_profiles
          where profile_status = 'active'
            and ($1::uuid is null or owner_user_id > $1::uuid)
          order by owner_user_id
          limit $2
        `,
        values: [
          input.afterUserId === null
            ? null
            : uuidSchema.parse(input.afterUserId),
          limit,
        ],
      });
      return Object.freeze(
        result.rows.map((row) => uuidSchema.parse(row.owner_user_id)),
      );
    },
  });
}
