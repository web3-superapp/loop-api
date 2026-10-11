import type { PoolClient } from "pg";

/**
 * Decision 0127: the Factory deduplicates a deployment by
 * `keccak(projectOwner, configVersion)` (`VersionAlreadyUsed`), and the
 * launchId only binds owner + version + configHash, so two projects of one
 * owner must never sign the same version. A new Hooks config version is
 * therefore allocated per project owner (the LOOP account; its wallets are
 * the possible `projectOwner` addresses), across all of that owner's
 * projects:
 *
 *   next = greatest(
 *     counter + 1,                          -- never reused, never lowered
 *     max(config_version of the owner's projects) + 1,
 *     max(config_version of any deployment task whose projectOwner is one
 *         of the owner's wallet addresses, active or archived) + 1)
 *
 * The counter row is upserted inside the caller's transaction, so its row
 * lock serialises concurrent saves of the same owner's projects; the
 * caller already holds the project row lock (project, then counter: one
 * lock order for owner and operator saves).
 */
export async function allocateHooksLaunchConfigVersion(
  client: PoolClient,
  ownerUserId: string,
): Promise<number> {
  const result = await client.query<{ config_version: number }>({
    text: `
      insert into public.hooks_launch_owner_config_versions as counter (
        owner_user_id, last_config_version
      )
      select $1::uuid, greatest(
        coalesce((
          select max(c.config_version)
          from public.hooks_launch_project_config_versions c
          where c.owner_user_id = $1::uuid
        ), 0),
        coalesce((
          select max(t.config_version)
          from public.hooks_launch_deployment_tasks t
          where t.project_owner in (
            select w.address from public.account_wallets w
            where w.owner_user_id = $1::uuid
          )
        ), 0)
      ) + 1
      on conflict (owner_user_id) do update set
        last_config_version = greatest(
          counter.last_config_version + 1,
          excluded.last_config_version
        ),
        updated_at = clock_timestamp()
      returning last_config_version as config_version
    `,
    values: [ownerUserId],
  });
  const version = result.rows[0]?.config_version;
  if (
    version === undefined ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    version > 0x7fff_ffff
  ) {
    throw new Error("Hooks launch config version allocation failed");
  }
  return version;
}
