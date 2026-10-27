/**
 * Decision 0187 (appendix A, S313b): the mining pool roster as SQL common
 * table expressions, for the read paths that project a community's weight
 * and power (community page, community standings, the discover list's
 * `sort=miningPower`, the per-hour community rank).
 *
 * `pool_version(config_version, approved_at, document)` is the parameter
 * version the roster is read under; `pool_roster` lists every verified
 * community with a bound asset under a `quantity` document (Decision 0189:
 * external tokens too), with
 *
 * - `kind` — `platform` when the bound asset is a launch2 MEME (any chain),
 *   else `external`;
 * - `token_weight` — the document's `assetWeights` entry for the asset, else
 *   "1" (the same rule as `mining-pool-roster.ts`);
 * - `participate` — neither the asset is in `excludedAssets` nor the
 *   community in `excludedCommunities`, and (external only) the asset is in
 *   `includedAssets`.
 *
 * A roster community's weight projection is its token weight (approved,
 * versioned by the parameter version); a non-participating roster community
 * is not ranked. Decision 0189: the roster is the only rule — without a
 * `pool_version` row it is empty and no community has a weight (the
 * `community_mining_weights` table is no longer read).
 */

/** The approved parameter version in force now. */
export const miningPoolVersionInForceSql = `
  pool_version as (
    select v.config_version,
      coalesce(v.approved_at, v.effective_from) as approved_at,
      v.document
    from public.mining_parameter_versions as v
    where v.status = 'approved' and v.effective_from <= clock_timestamp()
    order by v.effective_from desc
    limit 1
  )`;

/** The parameter version an epoch (`epochParameter`, e.g. `$1`) was settled under. */
export function miningPoolVersionOfEpochSql(epochParameter: string): string {
  return `
  pool_version as (
    select v.config_version,
      coalesce(v.approved_at, v.effective_from) as approved_at,
      v.document
    from public.mining_epochs as e
    join public.mining_parameter_versions as v on v.version_id = e.version_id
    where e.epoch_id = ${epochParameter}
  )`;
}

export const miningPoolRosterSql = `
  pool_roster as (
    select
      c.community_id,
      c.name as community_name,
      c.bound_asset_key as bound_asset_id,
      k.kind,
      pv.config_version as roster_config_version,
      pv.approved_at as roster_approved_at,
      coalesce(
        (
          select entry->>'weight'
          from jsonb_array_elements(
            coalesce(pv.document->'assetWeights', '[]'::jsonb)
          ) as entry
          where entry->>'assetId' = c.bound_asset_key
          limit 1
        ),
        '1'
      ) as token_weight,
      not exists (
        select 1
        from jsonb_array_elements_text(
          coalesce(pv.document->'excludedAssets', '[]'::jsonb)
        ) as excluded
        where excluded = c.bound_asset_key
      ) and not exists (
        select 1
        from jsonb_array_elements_text(
          coalesce(pv.document->'excludedCommunities', '[]'::jsonb)
        ) as excluded
        where excluded = c.community_id::text
      ) and (
        k.kind = 'platform' or exists (
          select 1
          from jsonb_array_elements_text(
            coalesce(pv.document->'includedAssets', '[]'::jsonb)
          ) as included
          where included = c.bound_asset_key
        )
      ) as participate
    from pool_version as pv
    join public.communities as c
      on c.verification_status = 'verified'
      and c.bound_asset_key is not null
    cross join lateral (
      select case when exists (
        select 1 from public.launch2_instances as i
        where c.bound_asset_key = i.chain_id || ':' || i.meme_address
      ) then 'platform' else 'external' end as kind
    ) as k
    where pv.document->>'assetPowerBasis' = 'quantity'
  )`;
