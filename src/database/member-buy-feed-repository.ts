import type { Pool } from "pg";
import { z } from "zod";

import {
  memberBuyFeedLane,
  type FeedPosition,
  type MemberBuyEventOutcome,
  type MemberBuyFeedCandidate,
  type MemberBuyFeedRepository,
  type RecordMemberBuyEventInput,
  type SettleMemberBuyEventInput,
} from "../features/community/member-buy-feed-repository.js";

/**
 * PostgreSQL side of the `community_member_buy_feed` lane (Decision 0097).
 * Reads the `pool_event` indexer facts and writes only the two lane tables
 * of migration 000047.
 */

export class MemberBuyFeedRepositoryUnavailableError extends Error {
  readonly code = "member_buy_feed_repository_unavailable";

  constructor() {
    super("The member buy feed repository is unavailable");
    this.name = "MemberBuyFeedRepositoryUnavailableError";
  }
}

const outcomes = [
  "pending",
  "sent",
  "rejected",
  "truncated",
  "skipped_not_buy",
  "skipped_private",
  "skipped_no_channel",
] as const satisfies readonly MemberBuyEventOutcome[];

const chainIdSchema = z.string().regex(/^eip155:[1-9][0-9]{0,9}$/);
const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const transactionHashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
const unsignedIntegerSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const signedIntegerSchema = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const logIndexSchema = z.number().int().min(0).max(2_147_483_647);
const assetIdSchema = z.string().min(1).max(128);
const messageIdSchema = z.string().regex(/^loop_buy_[0-9a-f]{32}$/);
const streamChannelIdSchema = z.string().regex(/^loop_community_[0-9a-f]{32}$/);

const positionRowSchema = z.object({
  last_block_number: unsignedIntegerSchema,
  last_log_index: logIndexSchema,
});

const matchRowSchema = z
  .object({
    community_id: uuidSchema,
    bound_asset_id: assetIdSchema,
    stream_channel_id: streamChannelIdSchema.nullable(),
    buyer_user_id: uuidSchema,
    public_profile_id: uuidSchema,
    trade_history_visibility: z.enum(["self", "everyone"]),
    anonymous_mode: z.boolean(),
    existing_outcome: z.enum(outcomes).nullable(),
  })
  .strict();

const candidateRowSchema = z.object({
  transaction_hash: transactionHashSchema,
  log_index: logIndexSchema,
  block_number: unsignedIntegerSchema,
  block_timestamp: z.date().nullable(),
  amount0: signedIntegerSchema,
  amount1: signedIntegerSchema,
  token0_asset_id: assetIdSchema,
  token0_symbol: z.string().min(1),
  token0_decimals: z.number().int().min(0).max(255),
  token1_asset_id: assetIdSchema,
  token1_symbol: z.string().min(1),
  token1_decimals: z.number().int().min(0).max(255),
  matches: z.array(matchRowSchema),
});

function unavailable(): never {
  throw new MemberBuyFeedRepositoryUnavailableError();
}

function position(row: unknown): FeedPosition {
  const parsed = positionRowSchema.parse(row);
  return Object.freeze({
    blockNumber: parsed.last_block_number,
    logIndex: parsed.last_log_index,
  });
}

const positionInputSchema = z.object({
  blockNumber: unsignedIntegerSchema,
  logIndex: logIndexSchema,
});

const eventKeyValues = (
  input: SettleMemberBuyEventInput | RecordMemberBuyEventInput,
): unknown[] => [
  chainIdSchema.parse(input.chainId),
  transactionHashSchema.parse(input.transactionHash),
  logIndexSchema.parse(input.logIndex),
  uuidSchema.parse(input.communityId),
];

/**
 * Candidate swaps with their member matches in one statement. A community
 * is eligible when it is verified and has a bound asset; a pool is read when
 * it is registered and holds such an asset. A swap matches a community when
 * its recipient or sender is an active wallet of an active member with an
 * activated profile; the recipient wins when both are members. The existing
 * lane row, if any, travels along so a handled pair is never redone.
 */
const candidatesSql = `
  with eligible as (
    select
      community.community_id,
      community.bound_asset_key,
      case when channel.provisioned_at is not null
        then channel.stream_channel_id end as stream_channel_id
    from public.communities as community
    left join public.community_channels as channel
      on channel.community_id = community.community_id
    where community.verification_status = 'verified'
      and community.bound_asset_key is not null
  ),
  relevant_pools as (
    select pool.pool_id, pool.token0_asset_id, pool.token1_asset_id
    from public.pools as pool
    where pool.chain_id = $1
      and pool.status = 'registered'
      and exists (
        select 1 from eligible
        where eligible.bound_asset_key in (pool.token0_asset_id, pool.token1_asset_id)
      )
  ),
  page as (
    select
      event.transaction_hash,
      event.log_index,
      event.block_number,
      event.block_timestamp,
      event.amount0,
      event.amount1,
      event.payload ->> 'recipient' as recipient,
      event.payload ->> 'sender' as sender,
      relevant_pools.token0_asset_id,
      relevant_pools.token1_asset_id
    from public.indexed_pool_events as event
    join relevant_pools on relevant_pools.pool_id = event.pool_id
    where event.chain_id = $1
      and event.event_kind = 'swap'
      and not event.removed
      and event.block_number >= $2::bigint
      and (event.block_number, event.log_index) > ($2::bigint, $3::integer)
      and event.block_number <= $4::bigint
    order by event.block_number asc, event.log_index asc
    limit $5
  )
  select
    page.transaction_hash,
    page.log_index,
    page.block_number::text as block_number,
    page.block_timestamp,
    page.amount0::text as amount0,
    page.amount1::text as amount1,
    page.token0_asset_id,
    token0.symbol as token0_symbol,
    token0.decimals as token0_decimals,
    page.token1_asset_id,
    token1.symbol as token1_symbol,
    token1.decimals as token1_decimals,
    coalesce((
      select json_agg(json_build_object(
        'community_id', eligible.community_id,
        'bound_asset_id', eligible.bound_asset_key,
        'stream_channel_id', eligible.stream_channel_id,
        'buyer_user_id', buyer.owner_user_id,
        'public_profile_id', profile.public_profile_id,
        'trade_history_visibility',
          coalesce(privacy.trade_history_visibility, 'everyone'),
        'anonymous_mode', coalesce(privacy.anonymous_mode, false),
        'existing_outcome', existing.outcome
      ) order by eligible.community_id)
      from eligible
      cross join lateral (
        select wallet.owner_user_id
        from public.account_wallets as wallet
        join public.community_memberships as membership
          on membership.owner_user_id = wallet.owner_user_id
          and membership.community_id = eligible.community_id
          and membership.status = 'active'
        where wallet.status = 'active'
          and wallet.address in (page.recipient, page.sender)
        order by (wallet.address = page.recipient) desc, wallet.owner_user_id
        limit 1
      ) as buyer
      join public.user_profiles as profile
        on profile.owner_user_id = buyer.owner_user_id
        and profile.profile_status = 'active'
      left join public.privacy_preferences_v2 as privacy
        on privacy.owner_user_id = buyer.owner_user_id
      left join public.community_member_buy_events as existing
        on existing.chain_id = $1
        and existing.transaction_hash = page.transaction_hash
        and existing.log_index = page.log_index
        and existing.community_id = eligible.community_id
      where eligible.bound_asset_key in (page.token0_asset_id, page.token1_asset_id)
    ), '[]'::json) as matches
  from page
  join public.assets as token0 on token0.asset_id = page.token0_asset_id
  join public.assets as token1 on token1.asset_id = page.token1_asset_id
  order by page.block_number asc, page.log_index asc
`;

export function createPostgresMemberBuyFeedRepository(
  pool: Pool,
): MemberBuyFeedRepository {
  async function guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      return unavailable();
    }
  }

  return Object.freeze({
    readPoolEventCheckpoint(chainId: string): Promise<string | null> {
      return guarded(async () => {
        const result = await pool.query<{ last_block_number: string }>({
          text: `
            select last_block_number::text as last_block_number
            from public.indexer_checkpoints
            where lane = 'pool_event' and chain_id = $1
          `,
          values: [chainIdSchema.parse(chainId)],
        });
        const row = result.rows[0];
        return row === undefined
          ? null
          : unsignedIntegerSchema.parse(row.last_block_number);
      });
    },

    readCursor(chainId: string): Promise<FeedPosition | null> {
      return guarded(async () => {
        const result = await pool.query<Record<string, unknown>>({
          text: `
            select last_block_number::text as last_block_number, last_log_index
            from public.community_feed_cursors
            where lane = $1 and chain_id = $2
          `,
          values: [memberBuyFeedLane, chainIdSchema.parse(chainId)],
        });
        const row = result.rows[0];
        return row === undefined ? null : position(row);
      });
    },

    initializeCursor(
      chainId: string,
      input: FeedPosition,
    ): Promise<FeedPosition> {
      return guarded(async () => {
        const parsed = positionInputSchema.parse(input);
        const values = [
          memberBuyFeedLane,
          chainIdSchema.parse(chainId),
          parsed.blockNumber,
          parsed.logIndex,
        ];
        await pool.query({
          text: `
            insert into public.community_feed_cursors (
              lane, chain_id, last_block_number, last_log_index
            )
            values ($1, $2, $3::bigint, $4)
            on conflict (lane, chain_id) do nothing
          `,
          values,
        });
        const result = await pool.query<Record<string, unknown>>({
          text: `
            select last_block_number::text as last_block_number, last_log_index
            from public.community_feed_cursors
            where lane = $1 and chain_id = $2
          `,
          values: values.slice(0, 2),
        });
        const row = result.rows[0];
        return row === undefined ? unavailable() : position(row);
      });
    },

    advanceCursor(chainId: string, input: FeedPosition): Promise<void> {
      return guarded(async () => {
        const parsed = positionInputSchema.parse(input);
        await pool.query({
          text: `
            update public.community_feed_cursors
            set last_block_number = $3::bigint,
                last_log_index = $4,
                updated_at = clock_timestamp()
            where lane = $1 and chain_id = $2
              and (last_block_number, last_log_index) < ($3::bigint, $4::integer)
          `,
          values: [
            memberBuyFeedLane,
            chainIdSchema.parse(chainId),
            parsed.blockNumber,
            parsed.logIndex,
          ],
        });
      });
    },

    listCandidates(
      input: Parameters<MemberBuyFeedRepository["listCandidates"]>[0],
    ): Promise<readonly MemberBuyFeedCandidate[]> {
      return guarded(async () => {
        const chainId = chainIdSchema.parse(input.chainId);
        const after = positionInputSchema.parse(input.after);
        const result = await pool.query<Record<string, unknown>>({
          text: candidatesSql,
          values: [
            chainId,
            after.blockNumber,
            after.logIndex,
            unsignedIntegerSchema.parse(input.throughBlockNumber),
            z.number().int().min(1).max(1_000).parse(input.limit),
          ],
        });
        return Object.freeze(
          result.rows.map((row) => {
            const parsed = candidateRowSchema.parse(row);
            return Object.freeze({
              chainId,
              transactionHash: parsed.transaction_hash,
              logIndex: parsed.log_index,
              blockNumber: parsed.block_number,
              blockTimestamp: parsed.block_timestamp?.toISOString() ?? null,
              token0: Object.freeze({
                assetId: parsed.token0_asset_id,
                symbol: parsed.token0_symbol,
                decimals: parsed.token0_decimals,
              }),
              token1: Object.freeze({
                assetId: parsed.token1_asset_id,
                symbol: parsed.token1_symbol,
                decimals: parsed.token1_decimals,
              }),
              amount0: parsed.amount0,
              amount1: parsed.amount1,
              matches: Object.freeze(
                parsed.matches.map((match) =>
                  Object.freeze({
                    communityId: match.community_id,
                    boundAssetId: match.bound_asset_id,
                    streamChannelId: match.stream_channel_id,
                    buyerUserId: match.buyer_user_id,
                    publicProfileId: match.public_profile_id,
                    tradeHistoryVisibility: match.trade_history_visibility,
                    anonymousMode: match.anonymous_mode,
                    existingOutcome: match.existing_outcome,
                  }),
                ),
              ),
            });
          }),
        );
      });
    },

    recordEvent(input: RecordMemberBuyEventInput): Promise<void> {
      return guarded(async () => {
        await pool.query({
          text: `
            insert into public.community_member_buy_events (
              chain_id, transaction_hash, log_index, community_id,
              buyer_user_id, block_number, outcome, stream_message_id
            )
            values ($1, $2, $3, $4, $5, $6::bigint, $7, $8)
            on conflict (chain_id, transaction_hash, log_index, community_id)
              do nothing
          `,
          values: [
            ...eventKeyValues(input),
            uuidSchema.parse(input.buyerUserId),
            unsignedIntegerSchema.parse(input.blockNumber),
            z.enum(outcomes).parse(input.outcome),
            input.streamMessageId === null
              ? null
              : messageIdSchema.parse(input.streamMessageId),
          ],
        });
      });
    },

    settleEvent(input: SettleMemberBuyEventInput): Promise<void> {
      return guarded(async () => {
        await pool.query({
          text: `
            update public.community_member_buy_events
            set outcome = $5,
                stream_message_id = case when $5 in ('sent', 'rejected')
                  then stream_message_id end,
                updated_at = clock_timestamp()
            where chain_id = $1 and transaction_hash = $2 and log_index = $3
              and community_id = $4 and outcome = 'pending'
          `,
          values: [
            ...eventKeyValues(input),
            z.enum(outcomes).exclude(["pending"]).parse(input.outcome),
          ],
        });
      });
    },
  });
}
