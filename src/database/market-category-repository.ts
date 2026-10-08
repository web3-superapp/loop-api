import type { Pool } from "pg";
import { z } from "zod";

/**
 * Candidate sets of the categorised market list (Decision 0100). Read-only
 * PostgreSQL facts written by other modules: Launch registers the project
 * token of a sale (`launches.project_asset_id`, Decision 0077), the MEME
 * launchpad lane registers every App-created curve token
 * (`meme_tokens.asset_id`, Decision 0101), and the community module binds a
 * verified community to an asset (Decision 0031).
 * Asset identity and status still come from the Asset Registry; this
 * repository only answers which asset IDs belong to a category.
 */

const assetIdSchema = z
  .string()
  .regex(/^eip155:[1-9][0-9]{0,9}:(native|0x[0-9a-f]{40})$/);

const memeRowSchema = z.object({ asset_id: assetIdSchema }).strict();

const rawSchema = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const memeCandidateRowSchema = z
  .object({
    asset_id: assetIdSchema,
    status: z.enum(["trading", "full", "paused", "graduated"]).nullable(),
    v_usd1: rawSchema.nullable(),
    v_token: rawSchema.nullable(),
    observed_at: z.date().nullable(),
    volume_24h: rawSchema.nullable(),
    price_24h_ago: rawSchema.nullable(),
  })
  .strict();

const communityRowSchema = z
  .object({
    asset_id: assetIdSchema,
    community_id: z.string().uuid(),
    name: z.string().min(1).max(40),
    logo_ref: z.string().min(1).nullable(),
  })
  .strict();

/**
 * Decision 0101: the curve snapshot of an App-created MEME token that has
 * not graduated; its market quote comes from here (`loop_curve`), not from
 * DexScreener. Raw 18-decimal integer strings.
 */
export interface MarketCategoryMemeCurve {
  readonly status: "trading" | "full" | "paused";
  readonly vUsd1: string;
  readonly vToken: string;
  /** Wallet-side USD1 traded in the last 24 hours, raw. */
  readonly volume24hRaw: string;
  /** Post-trade price (1e18) of the newest trade at or before now − 24 h. */
  readonly price24hAgoE18: string | null;
  readonly observedAt: string;
}

export interface MarketCategoryMemeRecord {
  readonly assetId: string;
  /** Null for a Launch project token or a graduated MEME token. */
  readonly curve: MarketCategoryMemeCurve | null;
}

export interface MarketCategoryCommunityRecord {
  readonly assetId: string;
  readonly communityId: string;
  readonly name: string;
  readonly logoRef: string | null;
}

export interface MarketCategoryRepository {
  /**
   * Distinct project tokens of registered Launch sales whose registry row
   * is not blocked, any chain (testnet included), ordered by asset ID.
   */
  listLaunchProjectAssetIds(limit: number): Promise<readonly string[]>;
  /**
   * Decision 0101: the `meme` category = App-created MEME tokens in
   * `trading`, `full`, or `graduated` (with their curve snapshot unless
   * graduated) ∪ the Launch project tokens, non-blocked, by asset ID.
   */
  listMemeCandidates(
    limit: number,
  ): Promise<readonly MarketCategoryMemeRecord[]>;
  /**
   * One verified community per bound, non-blocked registry asset (the one
   * with the most members, then the oldest, as the asset page picks it),
   * ordered by asset ID.
   */
  listVerifiedCommunityAssets(
    limit: number,
  ): Promise<readonly MarketCategoryCommunityRecord[]>;
}

export class MarketCategoryRepositoryUnavailableError extends Error {
  readonly code = "market_category_repository_unavailable";

  constructor() {
    super("The market category repository is unavailable");
    this.name = "MarketCategoryRepositoryUnavailableError";
  }
}

const limitSchema = z.number().int().min(1).max(500);

export function createPostgresMarketCategoryRepository(
  pool: Pool,
): MarketCategoryRepository {
  return Object.freeze({
    async listLaunchProjectAssetIds(limit: number) {
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select distinct l.project_asset_id as asset_id
          from public.launches as l
          join public.assets as a on a.asset_id = l.project_asset_id
          where l.project_asset_id is not null and a.status <> 'blocked'
          order by l.project_asset_id asc
          limit $1
        `,
        values: [limitSchema.parse(limit)],
      });
      return Object.freeze(
        result.rows.map((row) => memeRowSchema.parse(row).asset_id),
      );
    },

    async listMemeCandidates(limit: number) {
      const result = await pool.query<Record<string, unknown>>({
        text: `
          with meme as (
            select distinct on (m.asset_id)
              m.asset_id, m.status, m.v_usd1::text as v_usd1,
              m.v_token::text as v_token,
              coalesce(m.last_trade_at, m.chain_created_at, m.updated_at) as observed_at,
              (
                select coalesce(sum(tr.usd1_amount), 0)::text
                from public.meme_trades as tr
                where tr.meme_token_id = m.meme_token_id and not tr.removed
                  and tr.traded_at > clock_timestamp() - interval '24 hours'
              ) as volume_24h,
              (
                select tr.price_after_e18::text
                from public.meme_trades as tr
                where tr.meme_token_id = m.meme_token_id and not tr.removed
                  and tr.traded_at <= clock_timestamp() - interval '24 hours'
                order by tr.traded_at desc, tr.block_number desc, tr.log_index desc
                limit 1
              ) as price_24h_ago
            from public.meme_tokens as m
            join public.assets as a on a.asset_id = m.asset_id
            where m.asset_id is not null and a.status <> 'blocked'
              and m.status in ('trading', 'full', 'graduated')
            order by m.asset_id, m.created_at asc
          ),
          launch as (
            select distinct l.project_asset_id as asset_id
            from public.launches as l
            join public.assets as a on a.asset_id = l.project_asset_id
            where l.project_asset_id is not null and a.status <> 'blocked'
          )
          select asset_id, status, v_usd1, v_token, observed_at, volume_24h,
            price_24h_ago
          from meme
          union all
          select asset_id, null, null, null, null, null, null
          from launch
          where asset_id not in (select asset_id from meme)
          order by asset_id asc
          limit $1
        `,
        values: [limitSchema.parse(limit)],
      });
      return Object.freeze(
        result.rows.map((raw): MarketCategoryMemeRecord => {
          const row = memeCandidateRowSchema.parse(raw);
          return Object.freeze({
            assetId: row.asset_id,
            curve:
              row.status === null ||
              row.status === "graduated" ||
              row.v_usd1 === null ||
              row.v_token === null ||
              row.observed_at === null
                ? null
                : Object.freeze({
                    status: row.status,
                    vUsd1: row.v_usd1,
                    vToken: row.v_token,
                    volume24hRaw: row.volume_24h ?? "0",
                    price24hAgoE18: row.price_24h_ago,
                    observedAt: row.observed_at.toISOString(),
                  }),
          });
        }),
      );
    },

    async listVerifiedCommunityAssets(limit: number) {
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select asset_id, community_id, name, logo_ref
          from (
            select distinct on (c.bound_asset_key)
              c.bound_asset_key as asset_id,
              c.community_id,
              c.name,
              c.logo_ref
            from public.communities as c
            join public.assets as a on a.asset_id = c.bound_asset_key
            where c.verification_status = 'verified'
              and c.bound_asset_key is not null
              and a.status <> 'blocked'
            order by c.bound_asset_key, c.member_count desc, c.created_at asc,
              c.community_id asc
          ) as bound
          order by asset_id asc
          limit $1
        `,
        values: [limitSchema.parse(limit)],
      });
      return Object.freeze(
        result.rows.map((row) => {
          const parsed = communityRowSchema.parse(row);
          return Object.freeze({
            assetId: parsed.asset_id,
            communityId: parsed.community_id,
            name: parsed.name,
            logoRef: parsed.logo_ref,
          });
        }),
      );
    },
  });
}

function unavailable(): Promise<never> {
  return Promise.reject(new MarketCategoryRepositoryUnavailableError());
}

export function createUnavailableMarketCategoryRepository(): MarketCategoryRepository {
  return Object.freeze({
    listLaunchProjectAssetIds: unavailable,
    listMemeCandidates: unavailable,
    listVerifiedCommunityAssets: unavailable,
  });
}
