import type { Pool } from "pg";
import { z } from "zod";

import type {
  WalletAccountLookup,
  WalletAccountRecord,
} from "../features/profile/wallet-account-directory.js";

/**
 * Decision 0162: one query for a batch of addresses, through
 * `account_wallets_active_address_idx`. The earliest active wallet row wins
 * (the MEME `accountJoin` rule); the profile is joined only when active; a
 * missing privacy row reads as `everyone`, like every public trade read.
 */

const addressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);

const rowSchema = z.object({
  address: addressSchema,
  owner_user_id: z.string().uuid(),
  public_profile_id: z.string().nullable(),
  alias: z.string().nullable(),
  avatar_ref: z.string().nullable(),
  trade_visibility: z.enum(["self", "everyone"]),
});

export function createPostgresWalletAccountLookup(
  pool: Pool,
): WalletAccountLookup {
  return Object.freeze({
    async findByAddresses(rawAddresses: readonly string[]) {
      const addresses = [
        ...new Set(rawAddresses.map((value) => value.toLowerCase())),
      ].filter((value) => addressSchema.safeParse(value).success);
      if (addresses.length === 0) return [];
      const result = await pool.query({
        text: `
          select distinct on (w.address)
            w.address,
            w.owner_user_id::text as owner_user_id,
            p.public_profile_id::text as public_profile_id,
            p.alias,
            p.avatar_ref,
            coalesce(pv.trade_history_visibility, 'everyone') as trade_visibility
          from public.account_wallets as w
          left join public.user_profiles as p
            on p.owner_user_id = w.owner_user_id and p.profile_status = 'active'
          left join public.privacy_preferences_v2 as pv
            on pv.owner_user_id = w.owner_user_id
          where w.address = any($1::text[]) and w.status = 'active'
          order by w.address, w.first_seen_at asc, w.wallet_id asc
        `,
        values: [addresses],
      });
      return result.rows.map((raw): WalletAccountRecord => {
        const row = rowSchema.parse(raw);
        return Object.freeze({
          address: row.address,
          ownerUserId: row.owner_user_id,
          publicProfileId: row.public_profile_id,
          alias: row.alias,
          avatarRef: row.avatar_ref,
          tradeVisibility: row.trade_visibility,
        });
      });
    },
  });
}
