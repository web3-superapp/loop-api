import type { Pool } from "pg";
import { z } from "zod";

import { evmAddressPatternSource } from "../features/chain/chain-contract.js";
import { loopIdPatternSource } from "../features/identity/loop-id.js";
import { inviteCodePatternSource } from "../features/referral/invite-code.js";
import {
  WebRegistrationRepositoryUnavailableError,
  type WebAccountSummary,
  type WebInviter,
  type WebRegistrationRepository,
} from "../features/web/web-registration-repository.js";

/**
 * Decision 0179: PostgreSQL reads of the web registration surface. Only
 * `loop_users`, `user_profiles`, `account_wallets`, `invite_codes`, and
 * `referral_edges` are read; nothing is written here.
 */

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const userIdSchema = z.string().regex(canonicalUuidPattern);
const inviteCodeSchema = z.string().regex(new RegExp(inviteCodePatternSource));
const validDateSchema = z
  .instanceof(Date)
  .refine((value) => !Number.isNaN(value.getTime()));

const summaryRowSchema = z
  .object({
    loop_id: z.string().regex(new RegExp(loopIdPatternSource)),
    username: z.string().min(1).nullable(),
    activated_at: validDateSchema.nullable(),
    wallet_address: z
      .string()
      .regex(new RegExp(evmAddressPatternSource))
      .nullable(),
    invite_bound: z.boolean(),
  })
  .strict();

const inviterRowSchema = z
  .object({
    user_id: z.string().regex(canonicalUuidPattern),
    loop_id: z.string().regex(new RegExp(loopIdPatternSource)),
    username: z.string().min(1).nullable(),
  })
  .strict();

const activeAliasSql = `
  case when profiles.profile_status = 'active' then profiles.alias else null end
`;

function unavailable(error: unknown): never {
  throw new WebRegistrationRepositoryUnavailableError({ cause: error });
}

function toInviter(raw: unknown): WebInviter {
  const row = inviterRowSchema.parse(raw);
  return Object.freeze({
    userId: row.user_id,
    loopId: row.loop_id,
    username: row.username,
  });
}

export function createPostgresWebRegistrationRepository(
  pool: Pool,
): WebRegistrationRepository {
  return Object.freeze({
    async getAccountSummary(
      rawUserId: string,
    ): Promise<WebAccountSummary | null> {
      const userId = userIdSchema.parse(rawUserId);
      try {
        const result = await pool.query({
          text: `
            select
              users.loop_id,
              ${activeAliasSql} as username,
              case when profiles.profile_status = 'active'
                then profiles.activated_at else null end as activated_at,
              (
                select wallets.address
                from public.account_wallets as wallets
                where wallets.owner_user_id = users.id
                  and wallets.status = 'active'
                order by wallets.is_active desc, wallets.kind asc,
                  wallets.first_seen_at asc, wallets.wallet_id asc
                limit 1
              ) as wallet_address,
              exists (
                select 1 from public.referral_edges as edges
                where edges.invitee_user_id = users.id and edges.depth = 1
              ) as invite_bound
            from public.loop_users as users
            left join public.user_profiles as profiles
              on profiles.owner_user_id = users.id
            where users.id = $1
          `,
          values: [userId],
        });
        const raw: unknown = result.rows[0];
        if (raw === undefined) return null;
        const row = summaryRowSchema.parse(raw);
        return Object.freeze({
          loopId: row.loop_id,
          username: row.username,
          activatedAt: row.activated_at?.toISOString() ?? null,
          walletAddress: row.wallet_address,
          inviteBound: row.invite_bound,
        });
      } catch (error) {
        return unavailable(error);
      }
    },

    async findInviterByCode(rawCode: string): Promise<WebInviter | null> {
      const code = inviteCodeSchema.parse(rawCode);
      try {
        const result = await pool.query({
          text: `
            select users.id as user_id, users.loop_id,
              ${activeAliasSql} as username
            from public.invite_codes as codes
            join public.loop_users as users on users.id = codes.owner_user_id
            left join public.user_profiles as profiles
              on profiles.owner_user_id = users.id
            where codes.code = $1
          `,
          values: [code],
        });
        const raw: unknown = result.rows[0];
        return raw === undefined ? null : toInviter(raw);
      } catch (error) {
        return unavailable(error);
      }
    },

    async getDirectInviter(rawUserId: string): Promise<WebInviter | null> {
      const userId = userIdSchema.parse(rawUserId);
      try {
        const result = await pool.query({
          text: `
            select users.id as user_id, users.loop_id,
              ${activeAliasSql} as username
            from public.referral_edges as edges
            join public.loop_users as users on users.id = edges.inviter_user_id
            left join public.user_profiles as profiles
              on profiles.owner_user_id = users.id
            where edges.invitee_user_id = $1 and edges.depth = 1
          `,
          values: [userId],
        });
        const raw: unknown = result.rows[0];
        return raw === undefined ? null : toInviter(raw);
      } catch (error) {
        return unavailable(error);
      }
    },
  });
}
