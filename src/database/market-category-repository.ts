import type { Pool } from "pg";
import { z } from "zod";

/**
 * Candidate sets of the categorised market list (Decision 0100). Read-only
 * PostgreSQL facts written by other modules: Launch registers the project
 * token of a sale (`launches.project_asset_id`, Decision 0077) and the
 * community module binds a verified community to an asset (Decision 0031).
 * Asset identity and status still come from the Asset Registry; this
 * repository only answers which asset IDs belong to a category.
 */

const assetIdSchema = z
  .string()
  .regex(/^eip155:[1-9][0-9]{0,9}:(native|0x[0-9a-f]{40})$/);

const memeRowSchema = z.object({ asset_id: assetIdSchema }).strict();

const communityRowSchema = z
  .object({
    asset_id: assetIdSchema,
    community_id: z.string().uuid(),
    name: z.string().min(1).max(40),
    logo_ref: z.string().min(1).nullable(),
  })
  .strict();

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
    listVerifiedCommunityAssets: unavailable,
  });
}
