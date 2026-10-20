import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import {
  socialGraphCommandDigestVersion,
  socialGraphCommandIdempotencyScope,
} from "../features/community/community-contract.js";
import {
  PublicProfileIdempotencyConflictError,
  PublicProfileRepositoryUnavailableError,
  PublicProfileTargetNotFoundError,
  type ListTradesByTimeInput,
  type ListTradesInput,
  type ProfileCommunityCursorPosition,
  type ProfileCommunityRecord,
  type ProfileWalletRecord,
  type PublicProfileLookup,
  type PublicProfileRecord,
  type PublicProfileRepository,
  type RecommendedCommunityRecord,
  type RemoveFriendInput,
  type TimedTradeRow,
  type TradeRow,
} from "../features/profile/public-profile-repository.js";
import {
  afterCursor,
  cursorAt,
  cursorValues,
  micros,
} from "./wallet-activity-merge-repository.js";

/**
 * PostgreSQL public profile reads, friend removal, and recommended
 * communities (Decision 0095).
 */

const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
const uuidV4Schema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const loopIdSchema = z.string().regex(/^LOOP-[0-9A-HJKMNP-TV-Z]{8}$/);
const addressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);
const countSchema = z.coerce.number().int().min(0);
const visibilitySchema = z.enum(["self", "everyone"]);

const profileRowSchema = z
  .object({
    owner_user_id: uuidSchema,
    public_profile_id: uuidSchema,
    loop_id: loopIdSchema,
    alias: z.string().min(1).nullable(),
    avatar_ref: z.string().min(1).nullable(),
    bio: z.string().min(1).nullable(),
    activated_at: z.date().nullable(),
    followers: countSchema,
    following: countSchema,
    communities: countSchema,
    viewer_follows: z.boolean(),
    followed_by: z.boolean(),
    friends: z.boolean(),
    pending_out: z.boolean(),
    pending_in: z.boolean(),
    blocked: z.boolean(),
    blocked_by: z.boolean(),
    total_assets_visibility: visibilitySchema,
    trade_history_visibility: visibilitySchema,
    communities_visibility: visibilitySchema,
  })
  .strict();

const signedIntegerSchema = z.string().regex(/^-?[0-9]+$/);
const unsignedIntegerSchema = z.string().regex(/^[0-9]+$/);

const tradeRowSchema = z
  .object({
    source: z.enum(["swap", "transfer"]),
    transaction_hash: z.string().regex(/^0x[0-9a-f]{64}$/),
    log_index: z.number().int().min(0),
    block_number: unsignedIntegerSchema,
    block_timestamp: z.date().nullable(),
    token0_asset_id: z.string().nullable(),
    token1_asset_id: z.string().nullable(),
    amount0: signedIntegerSchema.nullable(),
    amount1: signedIntegerSchema.nullable(),
    asset_id: z.string().nullable(),
    direction: z.enum(["in", "out"]).nullable(),
    raw_value: unsignedIntegerSchema.nullable(),
  })
  .strict();

const communityRowSchema = z
  .object({
    community_id: uuidSchema,
    name: z.string().min(1),
    slug: z.string().min(1),
    description: z.string().min(1).nullable(),
    logo_ref: z.string().min(1).nullable(),
    verification_status: z.literal("verified"),
    bound_asset_key: z.string().min(1).nullable(),
    member_count: countSchema,
    created_at: z.date(),
    config_version: z.string().min(1),
  })
  .strict();

const profileCommunityRowSchema = z
  .object({
    community_id: uuidSchema,
    name: z.string().min(1),
    slug: z.string().min(1),
    logo_ref: z.string().min(1).nullable(),
    verification_status: z.enum(["pending", "verified", "rejected"]),
    member_count: countSchema,
    joined_at: z.date(),
    joined_at_micros: unsignedIntegerSchema,
  })
  .strict();

function toProfileCommunity(row: unknown): ProfileCommunityRecord {
  const parsed = profileCommunityRowSchema.parse(row);
  return Object.freeze({
    communityId: parsed.community_id,
    name: parsed.name,
    slug: parsed.slug,
    logoRef: parsed.logo_ref,
    memberCount: parsed.member_count,
    verificationStatus:
      parsed.verification_status === "verified" ? "verified" : "unverified",
    joinedAt: parsed.joined_at.toISOString(),
    joinedAtMicros: parsed.joined_at_micros,
  });
}

function toProfileRecord(row: unknown): PublicProfileRecord {
  const parsed = profileRowSchema.parse(row);
  return Object.freeze({
    targetUserId: parsed.owner_user_id,
    publicProfileId: parsed.public_profile_id,
    loopId: parsed.loop_id,
    alias: parsed.alias,
    avatarRef: parsed.avatar_ref,
    bio: parsed.bio,
    joinedAt: parsed.activated_at?.toISOString() ?? null,
    counts: Object.freeze({
      followers: parsed.followers,
      following: parsed.following,
      communities: parsed.communities,
    }),
    relationship: Object.freeze({
      following: parsed.viewer_follows,
      followedBy: parsed.followed_by,
      friendship: parsed.friends
        ? "friends"
        : parsed.pending_out
          ? "pending_out"
          : parsed.pending_in
            ? "pending_in"
            : "none",
      blocked: parsed.blocked,
      blockedBy: parsed.blocked_by,
    }),
    visibility: Object.freeze({
      totalAssets: parsed.total_assets_visibility,
      tradeHistory: parsed.trade_history_visibility,
      communities: parsed.communities_visibility,
    }),
  });
}

function toTradeRow(row: unknown): TradeRow {
  const parsed = tradeRowSchema.parse(row);
  const common = {
    transactionHash: parsed.transaction_hash,
    logIndex: parsed.log_index,
    blockNumber: parsed.block_number,
    blockTimestamp: parsed.block_timestamp?.toISOString() ?? null,
  };
  if (parsed.source === "swap") {
    if (
      parsed.token0_asset_id === null ||
      parsed.token1_asset_id === null ||
      parsed.amount0 === null ||
      parsed.amount1 === null
    ) {
      throw new PublicProfileRepositoryUnavailableError();
    }
    return Object.freeze({
      source: "swap" as const,
      ...common,
      token0AssetId: parsed.token0_asset_id,
      token1AssetId: parsed.token1_asset_id,
      amount0: parsed.amount0,
      amount1: parsed.amount1,
    });
  }
  if (
    parsed.asset_id === null ||
    parsed.direction === null ||
    parsed.raw_value === null
  ) {
    throw new PublicProfileRepositoryUnavailableError();
  }
  return Object.freeze({
    source: "transfer" as const,
    ...common,
    assetId: parsed.asset_id,
    direction: parsed.direction,
    rawValue: parsed.raw_value,
  });
}

function toTimedTradeRow(row: Record<string, unknown>): TimedTradeRow {
  const { at_micros: atMicros, ...rest } = row;
  const parsed = unsignedIntegerSchema.parse(atMicros);
  return Object.freeze({ ...toTradeRow(rest), atMicros: parsed });
}

/**
 * Decision 0169: the wallet's swaps and transfers (the `listTrades` rule)
 * with their merge time — the block time, else the observation time — in
 * the Decision 0167 merged order. `$1` chain, `$2` address, `$3..$7` the
 * cursor (`afterCursor`, first = 3), `$8` limit + 1.
 */
const tradesByTimeSql = `
  with swaps as (
    select
      event.transaction_hash,
      event.log_index,
      event.block_number,
      event.block_timestamp,
      event.observed_at,
      pool.token0_asset_id,
      pool.token1_asset_id,
      event.amount0,
      event.amount1
    from public.indexed_pool_events as event
    join public.pools as pool on pool.pool_id = event.pool_id
    where event.chain_id = $1
      and event.event_kind = 'swap'
      and not event.removed
      and event.payload ->> 'recipient' = $2
    union
    select
      event.transaction_hash,
      event.log_index,
      event.block_number,
      event.block_timestamp,
      event.observed_at,
      pool.token0_asset_id,
      pool.token1_asset_id,
      event.amount0,
      event.amount1
    from public.indexed_pool_events as event
    join public.pools as pool on pool.pool_id = event.pool_id
    where event.chain_id = $1
      and event.event_kind = 'swap'
      and not event.removed
      and event.payload ->> 'sender' = $2
  ),
  merged as (
    select
      'swap'::text as source,
      swaps.transaction_hash,
      swaps.log_index,
      swaps.block_number,
      swaps.block_timestamp,
      coalesce(swaps.block_timestamp, swaps.observed_at) as at,
      swaps.token0_asset_id,
      swaps.token1_asset_id,
      swaps.amount0::text as amount0,
      swaps.amount1::text as amount1,
      null::text as asset_id,
      null::text as direction,
      null::text as raw_value
    from swaps
    union all
    select
      'transfer'::text as source,
      timed.transaction_hash,
      timed.log_index,
      timed.block_number,
      timed.block_timestamp,
      coalesce(timed.block_timestamp, timed.observed_at),
      null::text,
      null::text,
      null::text,
      null::text,
      timed.asset_id,
      timed.direction,
      timed.raw_value
    from (
      select
        transfer.transaction_hash,
        transfer.log_index,
        transfer.block_number,
        transfer.observed_at,
        (
          select min(block_event.block_timestamp)
          from public.indexed_pool_events as block_event
          where block_event.chain_id = transfer.chain_id
            and block_event.block_number = transfer.block_number
        ) as block_timestamp,
        transfer.asset_id,
        case when transfer.to_address = $2 then 'in' else 'out' end
          as direction,
        transfer.raw_value::text as raw_value
      from public.indexed_transfers as transfer
      where transfer.chain_id = $1
        and not transfer.removed
        and (transfer.from_address = $2 or transfer.to_address = $2)
        and transfer.from_address <> transfer.to_address
        and not exists (
          select 1 from swaps
          where swaps.transaction_hash = transfer.transaction_hash
        )
    ) as timed
  )
  select
    merged.source,
    merged.transaction_hash,
    merged.log_index,
    merged.block_number::text as block_number,
    merged.block_timestamp,
    merged.token0_asset_id,
    merged.token1_asset_id,
    merged.amount0,
    merged.amount1,
    merged.asset_id,
    merged.direction,
    merged.raw_value,
    ${micros("merged.at")} as at_micros
  from merged
  where ${afterCursor({
    at: "merged.at",
    block: "merged.block_number",
    log: "merged.log_index",
    source: "erc20",
    hash: "merged.transaction_hash",
    first: 3,
  })}
  order by merged.at desc, merged.block_number desc, merged.log_index desc,
    merged.transaction_hash collate "C" desc
  limit $8
`;

/**
 * Decision 0169: the owner's current memberships (any non-banned row,
 * owner role included) of verified communities, newest join first. `$1`
 * owner, `$2` limit + 1, `$3` / `$4` the cursor (null on the first page).
 */
const profileCommunitiesSql = `
  select
    community.community_id,
    community.name,
    community.slug,
    community.logo_ref,
    community.verification_status,
    community.member_count,
    membership.joined_at,
    ${micros("membership.joined_at")} as joined_at_micros
  from public.community_memberships as membership
  join public.communities as community
    on community.community_id = membership.community_id
  where membership.owner_user_id = $1
    and membership.status <> 'banned'
    and community.verification_status = 'verified'
    and ($3::text is null
      or (membership.joined_at, community.community_id)
        < (${cursorAt("$3")}, $4::uuid))
  order by membership.joined_at desc, community.community_id desc
  limit $2
`;

const profileSelect = `
  select
    profile.owner_user_id,
    profile.public_profile_id,
    account.loop_id,
    profile.alias,
    profile.avatar_ref,
    profile.bio,
    profile.activated_at,
    (select count(*) from public.follow_edges as edge
      where edge.followee_user_id = profile.owner_user_id) as followers,
    (select count(*) from public.follow_edges as edge
      where edge.follower_user_id = profile.owner_user_id) as following,
    (select count(*)
      from public.community_memberships as membership
      join public.communities as community
        on community.community_id = membership.community_id
      where membership.owner_user_id = profile.owner_user_id
        and membership.status <> 'banned'
        and community.verification_status = 'verified') as communities,
    exists (select 1 from public.follow_edges as edge
      where edge.follower_user_id = $1
        and edge.followee_user_id = profile.owner_user_id) as viewer_follows,
    exists (select 1 from public.follow_edges as edge
      where edge.follower_user_id = profile.owner_user_id
        and edge.followee_user_id = $1) as followed_by,
    exists (select 1 from public.friendships as friendship
      where friendship.user_id_low = least($1::uuid, profile.owner_user_id)
        and friendship.user_id_high = greatest($1::uuid, profile.owner_user_id)
    ) as friends,
    exists (select 1 from public.friend_requests as request
      where request.requester_user_id = $1
        and request.recipient_user_id = profile.owner_user_id
        and request.status = 'pending'
        and request.expires_at > clock_timestamp()) as pending_out,
    exists (select 1 from public.friend_requests as request
      where request.requester_user_id = profile.owner_user_id
        and request.recipient_user_id = $1
        and request.status = 'pending'
        and request.expires_at > clock_timestamp()) as pending_in,
    exists (select 1 from public.user_blocks as block
      where block.kind = 'user'
        and block.owner_user_id = $1
        and block.target_user_id = profile.owner_user_id) as blocked,
    exists (select 1 from public.user_blocks as block
      where block.kind = 'user'
        and block.owner_user_id = profile.owner_user_id
        and block.target_user_id = $1) as blocked_by,
    coalesce(privacy.total_assets_visibility, 'everyone')
      as total_assets_visibility,
    coalesce(privacy.trade_history_visibility, 'everyone')
      as trade_history_visibility,
    coalesce(privacy.communities_visibility, 'everyone')
      as communities_visibility
  from public.user_profiles as profile
  join public.loop_users as account on account.id = profile.owner_user_id
  left join public.privacy_preferences_v2 as privacy
    on privacy.owner_user_id = profile.owner_user_id
`;

async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const value = await operation(client);
    await client.query("commit");
    return value;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      throw new PublicProfileRepositoryUnavailableError();
    }
    throw error;
  } finally {
    client.release();
  }
}

function translate(error: unknown): never {
  if (
    error instanceof PublicProfileIdempotencyConflictError ||
    error instanceof PublicProfileTargetNotFoundError ||
    error instanceof PublicProfileRepositoryUnavailableError
  ) {
    throw error;
  }
  throw new PublicProfileRepositoryUnavailableError();
}

export function createPostgresPublicProfileRepository(
  pool: Pool,
): PublicProfileRepository {
  return Object.freeze({
    async findProfile(input: {
      readonly viewerUserId: string;
      readonly lookup: PublicProfileLookup;
    }): Promise<PublicProfileRecord | null> {
      try {
        const viewerUserId = uuidSchema.parse(input.viewerUserId);
        const byId = "publicProfileId" in input.lookup;
        const key = byId
          ? uuidSchema.parse(
              (input.lookup as { publicProfileId: string }).publicProfileId,
            )
          : loopIdSchema.parse((input.lookup as { loopId: string }).loopId);
        const result = await pool.query<Record<string, unknown>>({
          text: `
            ${profileSelect}
            where ${byId ? "profile.public_profile_id = $2::uuid" : "account.loop_id = $2"}
              and profile.profile_status = 'active'
            limit 1
          `,
          values: [viewerUserId, key],
        });
        const row = result.rows[0];
        return row === undefined ? null : toProfileRecord(row);
      } catch (error) {
        return translate(error);
      }
    },

    async getActiveWallet(
      ownerUserId: string,
    ): Promise<ProfileWalletRecord | null> {
      try {
        const result = await pool.query<{
          wallet_id: string;
          address: string;
        }>({
          text: `
            select wallet_id, address
            from public.account_wallets
            where owner_user_id = $1 and is_active and status = 'active'
            limit 1
          `,
          values: [uuidSchema.parse(ownerUserId)],
        });
        const row = result.rows[0];
        return row === undefined
          ? null
          : Object.freeze({
              walletId: uuidSchema.parse(row.wallet_id),
              address: addressSchema.parse(row.address),
            });
      } catch (error) {
        return translate(error);
      }
    },

    async hasTransferCheckpoint(chainId: string): Promise<boolean> {
      try {
        const result = await pool.query<{ present: boolean }>({
          text: `
            select exists (
              select 1 from public.indexer_checkpoints
              where lane = 'erc20_transfer' and chain_id = $1
            ) as present
          `,
          values: [chainId],
        });
        return result.rows[0]?.present === true;
      } catch (error) {
        return translate(error);
      }
    },

    async listTrades(input: ListTradesInput): Promise<{
      readonly items: readonly TradeRow[];
      readonly hasMore: boolean;
    }> {
      try {
        const address = addressSchema.parse(input.address);
        const limit = z.number().int().min(1).max(50).parse(input.limit);
        const values: unknown[] = [input.chainId, address, limit + 1];
        let keyset = "";
        if (input.before !== undefined) {
          values.push(
            unsignedIntegerSchema.parse(input.before.blockNumber),
            z.number().int().min(0).parse(input.before.logIndex),
          );
          keyset = `where (merged.block_number, merged.log_index) < ($4::bigint, $5::integer)`;
        }
        const result = await pool.query<Record<string, unknown>>({
          text: `
            with swaps as (
              select
                event.transaction_hash,
                event.log_index,
                event.block_number,
                event.block_timestamp,
                pool.token0_asset_id,
                pool.token1_asset_id,
                event.amount0,
                event.amount1
              from public.indexed_pool_events as event
              join public.pools as pool on pool.pool_id = event.pool_id
              where event.chain_id = $1
                and event.event_kind = 'swap'
                and not event.removed
                and event.payload ->> 'recipient' = $2
              union
              select
                event.transaction_hash,
                event.log_index,
                event.block_number,
                event.block_timestamp,
                pool.token0_asset_id,
                pool.token1_asset_id,
                event.amount0,
                event.amount1
              from public.indexed_pool_events as event
              join public.pools as pool on pool.pool_id = event.pool_id
              where event.chain_id = $1
                and event.event_kind = 'swap'
                and not event.removed
                and event.payload ->> 'sender' = $2
            ),
            merged as (
              select
                'swap'::text as source,
                swaps.transaction_hash,
                swaps.log_index,
                swaps.block_number,
                swaps.block_timestamp,
                swaps.token0_asset_id,
                swaps.token1_asset_id,
                swaps.amount0::text as amount0,
                swaps.amount1::text as amount1,
                null::text as asset_id,
                null::text as direction,
                null::text as raw_value
              from swaps
              union all
              select
                'transfer'::text as source,
                transfer.transaction_hash,
                transfer.log_index,
                transfer.block_number,
                (
                  select min(block_event.block_timestamp)
                  from public.indexed_pool_events as block_event
                  where block_event.chain_id = transfer.chain_id
                    and block_event.block_number = transfer.block_number
                ) as block_timestamp,
                null::text,
                null::text,
                null::text,
                null::text,
                transfer.asset_id,
                case when transfer.to_address = $2 then 'in' else 'out' end,
                transfer.raw_value::text
              from public.indexed_transfers as transfer
              where transfer.chain_id = $1
                and not transfer.removed
                and (transfer.from_address = $2 or transfer.to_address = $2)
                and transfer.from_address <> transfer.to_address
                and not exists (
                  select 1 from swaps
                  where swaps.transaction_hash = transfer.transaction_hash
                )
            )
            select
              merged.source,
              merged.transaction_hash,
              merged.log_index,
              merged.block_number::text as block_number,
              merged.block_timestamp,
              merged.token0_asset_id,
              merged.token1_asset_id,
              merged.amount0,
              merged.amount1,
              merged.asset_id,
              merged.direction,
              merged.raw_value
            from merged
            ${keyset}
            order by merged.block_number desc, merged.log_index desc
            limit $3
          `,
          values,
        });
        const items = result.rows.slice(0, limit).map(toTradeRow);
        return Object.freeze({
          items: Object.freeze(items),
          hasMore: result.rows.length > limit,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listTradesByTime(input: ListTradesByTimeInput): Promise<{
      readonly items: readonly TimedTradeRow[];
      readonly hasMore: boolean;
    }> {
      try {
        const address = addressSchema.parse(input.address);
        const limit = z.number().int().min(1).max(50).parse(input.limit);
        if (input.before !== undefined) {
          unsignedIntegerSchema.parse(input.before.atMicros);
          unsignedIntegerSchema.parse(input.before.blockNumber);
          z.number().int().min(0).parse(input.before.logIndex);
        }
        const result = await pool.query<Record<string, unknown>>({
          text: tradesByTimeSql,
          values: [
            input.chainId,
            address,
            ...cursorValues(input.before),
            limit + 1,
          ],
        });
        const items = result.rows.slice(0, limit).map(toTimedTradeRow);
        return Object.freeze({
          items: Object.freeze(items),
          hasMore: result.rows.length > limit,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listProfileCommunities(input: {
      readonly ownerUserId: string;
      readonly limit: number;
      readonly before?: ProfileCommunityCursorPosition | undefined;
    }): Promise<{
      readonly items: readonly ProfileCommunityRecord[];
      readonly hasMore: boolean;
    }> {
      try {
        const ownerUserId = uuidSchema.parse(input.ownerUserId);
        const limit = z.number().int().min(1).max(50).parse(input.limit);
        const before =
          input.before === undefined
            ? [null, null]
            : [
                unsignedIntegerSchema.parse(input.before.joinedAtMicros),
                uuidSchema.parse(input.before.communityId),
              ];
        const result = await pool.query<Record<string, unknown>>({
          text: profileCommunitiesSql,
          values: [ownerUserId, limit + 1, ...before],
        });
        const items = result.rows.slice(0, limit).map(toProfileCommunity);
        return Object.freeze({
          items: Object.freeze(items),
          hasMore: result.rows.length > limit,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async removeFriend(input: RemoveFriendInput): Promise<{
      readonly publicProfileId: string;
      readonly removed: boolean;
    }> {
      try {
        const ownerUserId = uuidSchema.parse(input.ownerUserId);
        const targetPublicProfileId = uuidSchema.parse(
          input.targetPublicProfileId,
        );
        const idempotencyKey = uuidV4Schema.parse(input.idempotencyKey);
        const requestSha256 = sha256Schema.parse(input.requestSha256);
        const requestId = uuidV4Schema.parse(input.requestId);
        return await withTransaction(pool, async (client) => {
          const claimed = await client.query<{ id: string }>({
            text: `
              insert into public.idempotency_records (
                owner_user_id, scope, idempotency_key, key_source,
                request_sha256, digest_version
              )
              values ($1, $2, $3, 'client', $4, $5)
              on conflict (scope, idempotency_key)
              do update set last_seen_at = clock_timestamp()
              where idempotency_records.owner_user_id = excluded.owner_user_id
                and idempotency_records.key_source = excluded.key_source
                and idempotency_records.request_sha256 = excluded.request_sha256
                and idempotency_records.digest_version = excluded.digest_version
              returning id
            `,
            values: [
              ownerUserId,
              socialGraphCommandIdempotencyScope,
              idempotencyKey,
              requestSha256,
              socialGraphCommandDigestVersion,
            ],
          });
          const recordId = claimed.rows[0]?.id;
          if (recordId === undefined) {
            throw new PublicProfileIdempotencyConflictError();
          }
          const replay = await client.query<{
            public_profile_id: string;
            result_status: string;
          }>({
            text: `
              select profile.public_profile_id, event.result_status
              from public.social_graph_events as event
              join public.user_profiles as profile
                on profile.owner_user_id = event.target_user_id
              where event.idempotency_record_id = $1
                and event.event_type = 'friendship_removed'
              limit 1
            `,
            values: [recordId],
          });
          const replayed = replay.rows[0];
          if (replayed !== undefined) {
            return Object.freeze({
              publicProfileId: uuidSchema.parse(replayed.public_profile_id),
              removed: replayed.result_status === "removed",
            });
          }
          const target = await client.query<{
            owner_user_id: string;
            public_profile_id: string;
          }>({
            text: `
              select owner_user_id, public_profile_id
              from public.user_profiles
              where public_profile_id = $1 and profile_status = 'active'
              limit 1
            `,
            values: [targetPublicProfileId],
          });
          const targetRow = target.rows[0];
          if (
            targetRow === undefined ||
            targetRow.owner_user_id === ownerUserId
          ) {
            throw new PublicProfileTargetNotFoundError();
          }
          const deleted = await client.query({
            text: `
              delete from public.friendships
              where user_id_low = least($1::uuid, $2::uuid)
                and user_id_high = greatest($1::uuid, $2::uuid)
            `,
            values: [ownerUserId, targetRow.owner_user_id],
          });
          const removed = (deleted.rowCount ?? 0) > 0;
          await client.query({
            text: `
              insert into public.social_graph_events (
                actor_user_id, event_type, target_user_id, subject_id,
                result_status, reason_code, idempotency_record_id, request_id
              )
              values ($1, 'friendship_removed', $2, null, $3, null, $4, $5)
            `,
            values: [
              ownerUserId,
              targetRow.owner_user_id,
              removed ? "removed" : "absent",
              recordId,
              requestId,
            ],
          });
          return Object.freeze({
            publicProfileId: uuidSchema.parse(targetRow.public_profile_id),
            removed,
          });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listVerifiedCommunitiesByIds(
      ids: readonly string[],
    ): Promise<readonly RecommendedCommunityRecord[]> {
      if (ids.length === 0) {
        return Object.freeze([]);
      }
      try {
        const parsedIds = ids.map((id) => uuidSchema.parse(id));
        const result = await pool.query<Record<string, unknown>>({
          text: `
            select
              community.community_id,
              community.name,
              community.slug,
              community.description,
              community.logo_ref,
              community.verification_status,
              community.bound_asset_key,
              community.member_count,
              community.created_at,
              community.config_version
            from unnest($1::uuid[]) with ordinality as wanted(community_id, position)
            join public.communities as community
              on community.community_id = wanted.community_id
            where community.verification_status = 'verified'
            order by wanted.position
          `,
          values: [parsedIds],
        });
        return Object.freeze(
          result.rows.map((row) => {
            const parsed = communityRowSchema.parse(row);
            return Object.freeze({
              communityId: parsed.community_id,
              name: parsed.name,
              slug: parsed.slug,
              description: parsed.description,
              logoRef: parsed.logo_ref,
              verificationStatus: parsed.verification_status,
              boundAssetKey: parsed.bound_asset_key,
              memberCount: parsed.member_count,
              createdAt: parsed.created_at.toISOString(),
              configVersion: parsed.config_version,
            });
          }),
        );
      } catch (error) {
        return translate(error);
      }
    },
  });
}
