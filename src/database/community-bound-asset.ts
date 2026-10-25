import type { QueryResult } from "pg";

/**
 * Decision 0182: one token, one community.
 *
 * A `bound_asset_key` may be held by at most one community whose
 * `verification_status` is not `rejected` (a rejected community does not
 * occupy its token). Migration 000100 enforces it with the partial unique
 * index below; every write path that sets a key, or brings a rejected
 * community back, checks first through `findBoundAssetHolder` so the caller
 * gets a precise refusal instead of a raw 23505.
 */
export const communityBoundAssetUniqueIndex =
  "communities_bound_asset_key_unique";

interface BoundAssetClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(config: {
    readonly text: string;
    readonly values?: readonly unknown[];
  }): Promise<QueryResult<Row>>;
}

/**
 * Inside the caller's transaction: serialise every binder of `assetKey`
 * (transaction-scoped advisory lock, released at commit / rollback) and
 * return the community other than `exceptCommunityId` that holds it, or
 * null when it is free.
 */
export async function findBoundAssetHolder(
  client: BoundAssetClient,
  assetKey: string,
  exceptCommunityId: string | null,
): Promise<string | null> {
  await client.query({
    text: "select pg_advisory_xact_lock(hashtextextended($1, 0))",
    values: [`community_bound_asset:${assetKey}`],
  });
  return readBoundAssetHolder(client, assetKey, exceptCommunityId);
}

/** The same lookup without the lock (the 23505 fallback, after rollback). */
export async function readBoundAssetHolder(
  client: BoundAssetClient,
  assetKey: string,
  exceptCommunityId: string | null,
): Promise<string | null> {
  const result = await client.query<{ community_id: string }>({
    text: `
      select community_id::text as community_id
      from public.communities
      where bound_asset_key = $1
        and verification_status <> 'rejected'
        and ($2::uuid is null or community_id <> $2::uuid)
      order by created_at asc, community_id asc
      limit 1
    `,
    values: [assetKey, exceptCommunityId],
  });
  return result.rows[0]?.community_id ?? null;
}
