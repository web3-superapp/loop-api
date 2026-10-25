import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import {
  launch2CommunityBindingOutcomes,
  type Launch2CommunityBindingOutcome,
  type Launch2MemeAssetRepository,
} from "../features/launch2/launch2-meme-assets.js";
import { Launch2RepositoryUnavailableError } from "../features/launch2/launch2-ports.js";
import { findBoundAssetHolder } from "./community-bound-asset.js";
import { withV2Transaction } from "./v2-command-support.js";

/**
 * Decision 0125: the Asset Registry row and the one community binding
 * attempt of a deployed launch2 MEME. The registry row has the shape
 * `pnpm asset:register` writes (`chain_call`, `pending`, the observed
 * block); an existing row — fixture, operator, or blocked — is never
 * changed. The community is bound only when it is unbound, not rejected,
 * and still owned (active `owner` membership) by the instance owner; the
 * change appends a `community_role_events` operator row.
 *
 * Decision 0182 (one token, one community): when another community that is
 * not rejected already binds the MEME, the attempt is the same `conflict`
 * outcome and the result names that community in `takenByCommunityId` so
 * the lane can warn. Should a binder outside the advisory lock still reach
 * the unique index first, the transaction fails as unavailable and the next
 * tick re-runs the attempt, which then sees the holder.
 */

type Row = Record<string, unknown>;

function unavailable(): Error {
  return new Launch2RepositoryUnavailableError();
}

function textOf(row: Row | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== "string") throw unavailable();
  return value;
}

function nullableTextOf(row: Row | undefined, key: string): string | null {
  const value = row?.[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw unavailable();
  return value;
}

export function createPostgresLaunch2MemeAssetRepository(
  pool: Pool,
): Launch2MemeAssetRepository {
  return Object.freeze<Launch2MemeAssetRepository>({
    async listPendingMemeAssets(chainId) {
      try {
        const result = await pool.query<Row>({
          text: `
            select i.instance_id::text, i.chain_id, i.meme_address,
              (a.asset_id is not null) as asset_registered
            from public.launch2_instances i
            left join public.assets a
              on a.asset_id = i.chain_id || ':' || i.meme_address
            where i.chain_id = $1 and i.deployed_event_seen
              and (a.asset_id is null or i.community_binding is null)
            order by i.deploy_block_number, i.instance_id
            limit 50
          `,
          values: [chainId],
        });
        return result.rows.map((row) =>
          Object.freeze({
            instanceId: textOf(row, "instance_id"),
            chainId: textOf(row, "chain_id"),
            memeAddress: textOf(row, "meme_address"),
            assetRegistered: row["asset_registered"] === true,
          }),
        );
      } catch (error) {
        if (error instanceof Launch2RepositoryUnavailableError) throw error;
        throw unavailable();
      }
    },

    async registerMemeAsset(input) {
      try {
        return await withV2Transaction(pool, unavailable, async (client) => {
          const instance = (
            await client.query<Row>({
              text: `
                select i.chain_id, i.meme_address, i.owner_user_id::text,
                  i.community_binding, p.community_id::text
                from public.launch2_instances i
                left join public.launch_projects p on p.project_id = i.project_id
                where i.instance_id = $1 and i.deployed_event_seen
                for update of i
              `,
              values: [input.instanceId],
            })
          ).rows[0];
          if (instance === undefined) throw unavailable();
          const chainId = textOf(instance, "chain_id");
          const address = textOf(instance, "meme_address");
          const assetId = `${chainId}:${address}`;
          let inserted = false;
          if (input.identity !== null) {
            const result = await client.query({
              text: `
                insert into public.assets (
                  asset_id, chain_id, address, symbol, name, decimals, status,
                  source_kind, source_block_number, source_verified_at
                )
                values ($1, $2, $3, $4, $5, $6, 'pending', 'chain_call',
                  $7::numeric, clock_timestamp())
                on conflict (asset_id) do nothing
              `,
              values: [
                assetId,
                chainId,
                address,
                input.identity.symbol,
                input.identity.name,
                input.identity.decimals,
                input.identity.blockNumber.toString(10),
              ],
            });
            inserted = result.rowCount === 1;
          }
          const asset = (
            await client.query<Row>({
              text: `select status from public.assets where asset_id = $1`,
              values: [assetId],
            })
          ).rows[0];
          if (
            asset === undefined ||
            nullableTextOf(instance, "community_binding") !== null
          ) {
            return Object.freeze({
              assetId,
              inserted,
              communityBinding: null,
            });
          }
          const communityId = nullableTextOf(instance, "community_id");
          let outcome: Launch2CommunityBindingOutcome;
          let takenByCommunityId: string | null = null;
          if (communityId === null) {
            outcome = "none";
          } else if (textOf(asset, "status") === "blocked") {
            outcome = "asset_blocked";
          } else {
            const community = (
              await client.query<Row>({
                text: `
                  select bound_asset_key, verification_status
                  from public.communities where community_id = $1
                  for update
                `,
                values: [communityId],
              })
            ).rows[0];
            const ownerUserId = textOf(instance, "owner_user_id");
            const owner =
              community === undefined
                ? undefined
                : (
                    await client.query<Row>({
                      text: `
                        select 1 from public.community_memberships
                        where community_id = $1 and owner_user_id = $2
                          and role = 'owner' and status = 'active'
                      `,
                      values: [communityId, ownerUserId],
                    })
                  ).rows[0];
            const bound = nullableTextOf(community, "bound_asset_key");
            if (
              community === undefined ||
              community["verification_status"] === "rejected"
            ) {
              outcome = "community_unavailable";
            } else if (owner === undefined) {
              outcome = "not_owner";
            } else if (bound === assetId) {
              outcome = "already_bound";
            } else if (bound !== null) {
              outcome = "conflict";
            } else {
              takenByCommunityId = await findBoundAssetHolder(
                client,
                assetId,
                communityId,
              );
              if (takenByCommunityId !== null) {
                outcome = "conflict";
              } else {
                await client.query({
                  text: `
                    update public.communities
                    set bound_asset_key = $2,
                      record_version = record_version + 1,
                      updated_at = clock_timestamp()
                    where community_id = $1 and bound_asset_key is null
                  `,
                  values: [communityId, assetId],
                });
                await client.query({
                  text: `
                    insert into public.community_role_events (
                      community_id, actor_user_id, actor_type, target_user_id,
                      event_type, reason_code, idempotency_record_id, request_id
                    )
                    values ($1, null, 'operator', $2, 'community_profile_updated',
                      'launch2_asset_auto_bound', null, $3)
                  `,
                  values: [communityId, ownerUserId, randomUUID()],
                });
                outcome = "bound";
              }
            }
          }
          if (!launch2CommunityBindingOutcomes.includes(outcome)) {
            throw unavailable();
          }
          await client.query({
            text: `
              update public.launch2_instances
              set community_binding = $2, community_binding_at = clock_timestamp()
              where instance_id = $1 and community_binding is null
            `,
            values: [input.instanceId, outcome],
          });
          return Object.freeze({
            assetId,
            inserted,
            communityBinding: outcome,
            ...(takenByCommunityId === null ? {} : { takenByCommunityId }),
          });
        });
      } catch (error) {
        if (error instanceof Launch2RepositoryUnavailableError) throw error;
        throw unavailable();
      }
    },
  });
}
